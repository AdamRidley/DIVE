import { AudioClip, AudioRole, Overlay, Scene, Story, StoryAudio } from './types';
import { resolveLocalized } from './locale';
import {
  AudioSyncPhase,
  DEFAULT_PREROLL_SECONDS,
  MAX_PREROLL_SECONDS,
  MIN_PREROLL_SECONDS,
  planAudioSync,
} from './audio-sync-plan';

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
  lastAssigned: number;
  phase: AudioSyncPhase;
  clockMoved: boolean;
  preroll: number;
  resyncs: number;
  playAt: number;
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
  mode: 'idle' | 'locked' | 'seek' | 'hold' | 'start';
  prerollMs: number;
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
      return {
        spec,
        element,
        playLock: null,
        lastSeekAt: 0,
        lastDrift: 0,
        lastTarget: 0,
        lastAssigned: 0,
        phase: 'locked',
        clockMoved: false,
        preroll: DEFAULT_PREROLL_SECONDS,
        resyncs: 0,
        playAt: 0,
      };
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
        clip.phase = 'locked';
        clip.clockMoved = false;
        clip.resyncs = 0;
        if (clip.element.playbackRate !== 1) {
          clip.element.playbackRate = 1;
        }
        clip.lastDrift = 0;
        clip.lastTarget = mediaTime;
        continue;
      }

      let mode: AudioSyncDebug['mode'] = 'locked';
      let drift = 0;
      let holdLeft = 0;

      if (Number.isFinite(mediaTime) && mediaTime >= 0 && clip.element.readyState >= 1) {
        let audioTime = clip.element.currentTime;
        drift = audioTime - mediaTime;
        if (clip.spec.loop && Number.isFinite(duration) && duration > 0) {
          if (drift > duration / 2) {
            drift -= duration;
            audioTime -= duration;
          } else if (drift < -duration / 2) {
            drift += duration;
            audioTime += duration;
          }
        }

        const plan = planAudioSync({
          now,
          mediaTime,
          audioTime,
          seeking: clip.element.seeking,
          readyState: clip.element.readyState,
          paused: clip.element.paused,
          hard: Boolean(options.hard),
          phase: clip.phase,
          lastSeekAt: clip.lastSeekAt,
          lastAssigned: clip.lastAssigned,
          clockMoved: clip.clockMoved,
          preroll: clip.preroll,
          resyncs: clip.resyncs,
        });

        if (!clip.clockMoved && plan.clockMoved && clip.playAt) {
          const startup = (now - clip.playAt) / 1000;
          if (startup > 0.04 && startup < 0.5) {
            clip.preroll = Math.max(
              MIN_PREROLL_SECONDS,
              Math.min(MAX_PREROLL_SECONDS, clip.preroll * 0.55 + startup * 0.45),
            );
          }
        }

        clip.phase = plan.phase;
        clip.lastSeekAt = plan.lastSeekAt;
        clip.lastAssigned = plan.lastAssigned;
        clip.clockMoved = plan.clockMoved;
        clip.resyncs = plan.resyncs;
        mode = plan.mode;
        holdLeft = plan.holdMs;
        if (plan.event) {
          this.markEvent(plan.event);
        }

        if (plan.action === 'seek' && plan.seekTo !== undefined) {
          try {
            if (!clip.element.paused) {
              clip.element.pause();
            }
            clip.element.currentTime = plan.seekTo;
            if (clip.element.playbackRate !== 1) {
              clip.element.playbackRate = 1;
            }
            drift = clip.element.currentTime - mediaTime;
          } catch {
            mode = 'hold';
          }
        }
      }

      clip.lastDrift = drift;
      clip.lastTarget = mediaTime;
      clip.element.volume = clip.spec.volume * this.masterVolume;
      clip.element.muted = this.muted;
      const shouldPlay = clip.phase === 'starting' || clip.phase === 'locked';
      if (!shouldPlay && !clip.element.paused) {
        clip.element.pause();
      }
      if (shouldPlay && clip.element.paused && !clip.playLock) {
        if (!clip.playAt || clip.phase === 'starting') {
          clip.playAt = now;
        }
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
          ratePercent: 100,
          targetRatePercent: 100,
          seeking: clip.element.seeking,
          holdMs: holdLeft,
          mode,
          prerollMs: clip.preroll * 1000,
        };
        this.maybeLogSample(now, storyTimeMs, playing, options, clip, mediaTime, drift, mode, holdLeft);
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
    mode: AudioSyncDebug['mode'],
    holdLeft: number,
  ): void {
    const event = [this.pendingEvent, options.event].filter(Boolean).join('+') || undefined;
    this.pendingEvent = undefined;
    const noteworthy = Boolean(event || options.hard || mode === 'seek' || mode === 'hold' || mode === 'start');
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
      ratePct: 100,
      targetRatePct: Math.round(clip.preroll * 1000),
      mode,
      holdMs: holdLeft,
      seeking: clip.element.seeking,
      readyState: clip.element.readyState,
      paused: clip.element.paused,
      correcting: false,
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
