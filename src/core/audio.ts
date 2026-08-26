import { AudioClip, AudioRole, Overlay, Scene, Story, StoryAudio } from './types';
import { resolveLocalized } from './locale';

export interface NormalizedAudioClip {
  id: string;
  src: string;
  startTime: number;
  endTime: number;
  offset: number;
  volume: number;
  loop: boolean;
  lang?: string;
  role: AudioRole;
}

function asClip(input: string | AudioClip, fallbackId: string, storyDuration: number): NormalizedAudioClip | null {
  const raw = typeof input === 'string' ? { src: input } : input;
  if (!raw?.src) {
    return null;
  }

  const startTime = Number.isFinite(raw.startTime) ? Math.max(0, raw.startTime as number) : 0;
  const endTime = Number.isFinite(raw.endTime) ? Math.max(startTime, raw.endTime as number) : storyDuration;
  return {
    id: fallbackId,
    src: raw.src,
    startTime,
    endTime,
    offset: Number.isFinite(raw.offset) ? Math.max(0, raw.offset as number) : 0,
    volume: Number.isFinite(raw.volume) ? Math.min(1, Math.max(0, raw.volume as number)) : 1,
    loop: Boolean(raw.loop),
    lang: raw.lang,
    role: raw.role || 'narration',
  };
}

export function collectStoryAudio(story: Story, baseUrl: string): NormalizedAudioClip[] {
  const clips: NormalizedAudioClip[] = [];
  const declared: StoryAudio | undefined = story.audio;
  const declaredList: Array<string | AudioClip> = !declared
    ? []
    : Array.isArray(declared)
      ? declared
      : [declared];

  declaredList.forEach((item, index) => {
    const clip = asClip(item, `story-${index}`, story.duration);
    if (clip) {
      clip.src = new URL(clip.src, baseUrl).href;
      clips.push(clip);
    }
  });

  story.scenes.forEach((scene: Scene, sceneIndex: number) => {
    scene.overlays.forEach((overlay: Overlay, overlayIndex: number) => {
      if (overlay.type !== 'audio') {
        return;
      }
      if (typeof overlay.content === 'object' && overlay.content) {
        Object.entries(overlay.content).forEach(([lang, src]) => {
          const clip = asClip({
            src,
            lang,
            startTime: scene.startTime + overlay.time,
            endTime: scene.startTime + overlay.time + overlay.duration,
            volume: overlay.volume,
          }, `overlay-${sceneIndex}-${overlayIndex}-${lang}`, story.duration);
          if (clip) {
            clip.src = new URL(clip.src, baseUrl).href;
            clips.push(clip);
          }
        });
        return;
      }
      const clip = asClip({
        src: resolveLocalized(overlay.content, 'en'),
        startTime: scene.startTime + overlay.time,
        endTime: scene.startTime + overlay.time + overlay.duration,
        volume: overlay.volume,
      }, `overlay-${sceneIndex}-${overlayIndex}`, story.duration);
      if (clip) {
        clip.src = new URL(clip.src, baseUrl).href;
        clips.push(clip);
      }
    });
  });

  return clips;
}

export function filterAudioClips(
  clips: NormalizedAudioClip[],
  lang: string,
  options: { descriptions: boolean },
): NormalizedAudioClip[] {
  return clips.filter((clip) => {
    if (clip.role === 'descriptions') {
      return options.descriptions;
    }
    if (clip.lang && clip.lang !== lang) {
      return false;
    }
    return true;
  });
}

interface ManagedClip {
  spec: NormalizedAudioClip;
  element: HTMLAudioElement;
  playLock: Promise<void> | null;
  lastSeekAt: number;
  lastDrift: number;
  lastTarget: number;
  rate: number;
  lastRateAt: number;
  correcting: boolean;
}

/** Start rate-correcting only once drift is clearly worth it. */
const RATE_ENTER_SECONDS = 0.18;
/** Stop correcting once back inside this band (hysteresis vs enter). */
const RATE_EXIT_SECONDS = 0.08;
/** Drift that maps to the max target-rate offset (wider = gentler). */
const RATE_DRIFT_SPAN_SECONDS = 4;
/** Cap on |target playbackRate - 1|. */
const MAX_TARGET_RATE_DELTA = 0.12;
/** How fast the applied rate may move toward the target. */
const MAX_RATE_CHANGE_PER_SECOND = 0.01;
/** Don't poke the decoder for tinier rate writes than this. */
const RATE_WRITE_EPSILON = 0.001;
/** Only hard-seek for a real jump (scrub / scene skip). */
const HARD_SEEK_SECONDS = 1.25;
/** Ignore further seeks after a jump while the decoder settles. */
const SEEK_HOLD_MS = 100;

function applySlewedRate(clip: ManagedClip, targetRate: number, now: number): void {
  const previous = clip.lastRateAt || now;
  const dt = Math.max(0, Math.min(0.25, (now - previous) / 1000));
  clip.lastRateAt = now;
  const maxStep = MAX_RATE_CHANGE_PER_SECOND * dt;
  const delta = targetRate - clip.rate;
  const step = Math.max(-maxStep, Math.min(maxStep, delta));
  clip.rate += step;
  if (Math.abs(clip.rate - 1) < RATE_WRITE_EPSILON && Math.abs(targetRate - 1) < RATE_WRITE_EPSILON) {
    clip.rate = 1;
  }
  if (Math.abs(clip.element.playbackRate - clip.rate) >= RATE_WRITE_EPSILON) {
    clip.element.playbackRate = clip.rate;
  }
}

export interface AudioSyncDebug {
  clipId: string;
  targetSeconds: number;
  audioSeconds: number;
  driftMs: number;
  ratePercent: number;
  targetRatePercent: number;
  seeking: boolean;
  holdMs: number;
  mode: 'idle' | 'locked' | 'rate' | 'seek' | 'hold';
}

export interface AudioSyncLogRow {
  t: number;
  event?: string;
  storyMs: number;
  playing: boolean;
  hard: boolean;
  clipId: string;
  targetS: number;
  audioS: number;
  driftMs: number;
  ratePct: number;
  targetRatePct: number;
  mode: AudioSyncDebug['mode'] | 'idle';
  holdMs: number;
  seeking: boolean;
  readyState: number;
  paused: boolean;
  correcting: boolean;
}

const MAX_SYNC_LOG = 16000;
const LOG_SAMPLE_MS = 50;

export class AudioEngine {
  private clips: ManagedClip[] = [];
  private muted = false;
  private masterVolume = 1;
  private unlocked = false;
  private lastDebug: AudioSyncDebug | null = null;
  private log: AudioSyncLogRow[] = [];
  private logStartedAt = 0;
  private lastLogAt = 0;
  private pendingEvent: string | undefined;

  configure(specs: NormalizedAudioClip[]): void {
    this.dispose();
    this.clips = specs.map((spec) => {
      const element = new Audio();
      element.preload = 'auto';
      element.src = spec.src;
      element.loop = spec.loop;
      element.playbackRate = 1;
      element.volume = spec.volume * this.masterVolume;
      element.muted = this.muted;
      return { spec, element, playLock: null, lastSeekAt: 0, lastDrift: 0, lastTarget: 0, rate: 1, lastRateAt: 0, correcting: false };
    });
  }

  get hasAudio(): boolean {
    return this.clips.length > 0;
  }

  get isMuted(): boolean {
    return this.muted;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    for (const clip of this.clips) {
      clip.element.muted = muted;
    }
  }

  unlock(): void {
    if (this.unlocked) {
      return;
    }
    this.unlocked = true;
    for (const clip of this.clips) {
      const playAttempt = clip.element.play();
      if (playAttempt) {
        playAttempt.then(() => clip.element.pause()).catch(() => {
          this.unlocked = false;
        });
      }
    }
  }

  sync(storyTimeMs: number, playing: boolean, options: { hard?: boolean; event?: string } = {}): void {
    const now = performance.now();
    let reported = false;

    for (const clip of this.clips) {
      const active = playing && storyTimeMs >= clip.spec.startTime && storyTimeMs < clip.spec.endTime;
      let mediaTime = (storyTimeMs - clip.spec.startTime + clip.spec.offset) / 1000;
      const duration = clip.element.duration;
      if (clip.spec.loop && Number.isFinite(duration) && duration > 0) {
        mediaTime = ((mediaTime % duration) + duration) % duration;
      }

      if (!active) {
        if (!clip.element.paused) {
          clip.element.pause();
        }
        clip.rate = 1;
        clip.lastRateAt = now;
        clip.correcting = false;
        if (clip.element.playbackRate !== 1) {
          clip.element.playbackRate = 1;
        }
        clip.lastDrift = 0;
        clip.lastTarget = mediaTime;
        continue;
      }

      let mode: AudioSyncDebug['mode'] = 'locked';
      let drift = 0;
      let targetRate = 1;
      const holdLeft = Math.max(0, SEEK_HOLD_MS - (now - clip.lastSeekAt));

      if (Number.isFinite(mediaTime) && mediaTime >= 0 && clip.element.readyState >= 1) {
        drift = clip.element.currentTime - mediaTime;
        if (clip.spec.loop && Number.isFinite(duration) && duration > 0) {
          if (drift > duration / 2) drift -= duration;
          if (drift < -duration / 2) drift += duration;
        }

        const shouldHard = options.hard || Math.abs(drift) >= HARD_SEEK_SECONDS;
        if (shouldHard && holdLeft <= 0) {
          try {
            clip.element.currentTime = mediaTime;
            clip.rate = 1;
            clip.lastRateAt = now;
            clip.correcting = false;
            if (clip.element.playbackRate !== 1) {
              clip.element.playbackRate = 1;
            }
            clip.lastSeekAt = now;
            drift = 0;
            targetRate = 1;
            mode = 'seek';
          } catch {
            mode = 'hold';
          }
        } else if (holdLeft > 0) {
          targetRate = 1;
          clip.correcting = false;
          mode = 'hold';
        } else {
          const abs = Math.abs(drift);
          if (!clip.correcting && abs >= RATE_ENTER_SECONDS) {
            clip.correcting = true;
          } else if (clip.correcting && abs <= RATE_EXIT_SECONDS) {
            clip.correcting = false;
          }

          if (clip.correcting) {
            const adj = Math.max(-MAX_TARGET_RATE_DELTA, Math.min(MAX_TARGET_RATE_DELTA, drift / RATE_DRIFT_SPAN_SECONDS));
            targetRate = 1 - adj;
            mode = 'rate';
          } else {
            targetRate = 1;
            mode = Math.abs(clip.rate - 1) < RATE_WRITE_EPSILON ? 'locked' : 'rate';
          }
        }

        if (mode !== 'seek' && (clip.correcting || Math.abs(clip.rate - 1) >= RATE_WRITE_EPSILON || Math.abs(targetRate - 1) >= RATE_WRITE_EPSILON)) {
          applySlewedRate(clip, targetRate, now);
        }
      }

      clip.lastDrift = drift;
      clip.lastTarget = mediaTime;
      clip.element.volume = clip.spec.volume * this.masterVolume;
      clip.element.muted = this.muted;
      if (clip.element.paused && !clip.playLock) {
        const playAttempt = clip.element.play();
        if (playAttempt) {
          clip.playLock = playAttempt.then(() => {
            clip.playLock = null;
          }).catch(() => {
            clip.playLock = null;
          });
        }
      }

      if (!reported) {
        reported = true;
        this.lastDebug = {
          clipId: clip.spec.id,
          targetSeconds: mediaTime,
          audioSeconds: clip.element.currentTime,
          driftMs: drift * 1000,
          ratePercent: clip.rate * 100,
          targetRatePercent: targetRate * 100,
          seeking: clip.element.seeking,
          holdMs: holdLeft,
          mode,
        };
        this.maybeLogSample(now, storyTimeMs, playing, options, clip, mediaTime, drift, targetRate, mode, holdLeft);
      }
    }

    if (!reported) {
      this.lastDebug = null;
      this.maybeLogIdle(now, storyTimeMs, playing, options);
    }
  }

  private maybeLogSample(
    now: number,
    storyTimeMs: number,
    playing: boolean,
    options: { hard?: boolean; event?: string },
    clip: ManagedClip,
    mediaTime: number,
    drift: number,
    targetRate: number,
    mode: AudioSyncDebug['mode'],
    holdLeft: number,
  ): void {
    const event = [this.pendingEvent, options.event].filter(Boolean).join('+') || undefined;
    this.pendingEvent = undefined;
    const noteworthy = Boolean(event || options.hard || mode === 'seek' || mode === 'hold');
    if (!noteworthy && now - this.lastLogAt < LOG_SAMPLE_MS) {
      return;
    }
    this.lastLogAt = now;
    this.appendLog({
      t: now,
      event,
      storyMs: storyTimeMs,
      playing,
      hard: Boolean(options.hard),
      clipId: clip.spec.id,
      targetS: mediaTime,
      audioS: clip.element.currentTime,
      driftMs: drift * 1000,
      ratePct: clip.rate * 100,
      targetRatePct: targetRate * 100,
      mode,
      holdMs: holdLeft,
      seeking: clip.element.seeking,
      readyState: clip.element.readyState,
      paused: clip.element.paused,
      correcting: clip.correcting,
    });
  }

  private maybeLogIdle(
    now: number,
    storyTimeMs: number,
    playing: boolean,
    options: { hard?: boolean; event?: string },
  ): void {
    const event = [this.pendingEvent, options.event].filter(Boolean).join('+') || undefined;
    this.pendingEvent = undefined;
    if (!event && !options.hard && now - this.lastLogAt < LOG_SAMPLE_MS) {
      return;
    }
    this.lastLogAt = now;
    this.appendLog({
      t: now,
      event,
      storyMs: storyTimeMs,
      playing,
      hard: Boolean(options.hard),
      clipId: '',
      targetS: storyTimeMs / 1000,
      audioS: Number.NaN,
      driftMs: Number.NaN,
      ratePct: 100,
      targetRatePct: 100,
      mode: 'idle',
      holdMs: 0,
      seeking: false,
      readyState: 0,
      paused: true,
      correcting: false,
    });
  }

  getDebug(): AudioSyncDebug | null {
    return this.lastDebug;
  }

  markEvent(event: string): void {
    this.pendingEvent = this.pendingEvent ? `${this.pendingEvent}+${event}` : event;
  }

  exportLog(): string {
    return JSON.stringify({
      startedAt: this.logStartedAt,
      exportedAt: performance.now(),
      sampleHzHint: 1000 / LOG_SAMPLE_MS,
      rows: this.log,
    });
  }

  getLogLength(): number {
    return this.log.length;
  }

  clearLog(): void {
    this.log = [];
    this.logStartedAt = 0;
    this.lastLogAt = 0;
  }

  private appendLog(row: AudioSyncLogRow): void {
    if (!this.logStartedAt) {
      this.logStartedAt = row.t;
    }
    this.log.push(row);
    if (this.log.length > MAX_SYNC_LOG) {
      this.log.splice(0, this.log.length - MAX_SYNC_LOG);
    }
  }

  dispose(): void {
    for (const clip of this.clips) {
      clip.element.pause();
      clip.element.playbackRate = 1;
      clip.element.removeAttribute('src');
      clip.element.load();
    }
    this.clips = [];
    this.unlocked = false;
    this.lastDebug = null;
  }
}
