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
}

/** Deadband: treat as locked. */
const RATE_DEADBAND_SECONDS = 0.04;
/** Max |playbackRate - 1| while dragging back to the clock. */
const MAX_RATE_DELTA = 0.08;
/** Seconds of drift that rate-corrects in about this many seconds at max delta. */
const RATE_CATCHUP_SECONDS = 0.8;
/** Only hard-seek for a real jump (scrub / scene skip). */
const HARD_SEEK_SECONDS = 1.25;
/** Ignore further seeks after a jump while the decoder settles. */
const SEEK_HOLD_MS = 800;

export interface AudioSyncDebug {
  clipId: string;
  targetSeconds: number;
  audioSeconds: number;
  driftMs: number;
  ratePercent: number;
  seeking: boolean;
  holdMs: number;
  mode: 'idle' | 'locked' | 'rate' | 'seek' | 'hold';
}

export class AudioEngine {
  private clips: ManagedClip[] = [];
  private muted = false;
  private masterVolume = 1;
  private unlocked = false;
  private lastDebug: AudioSyncDebug | null = null;

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
      return { spec, element, playLock: null, lastSeekAt: 0, lastDrift: 0, lastTarget: 0 };
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

  sync(storyTimeMs: number, playing: boolean, options: { hard?: boolean } = {}): void {
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
        clip.element.playbackRate = 1;
        clip.lastDrift = 0;
        clip.lastTarget = mediaTime;
        continue;
      }

      let mode: AudioSyncDebug['mode'] = 'locked';
      let drift = 0;
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
            clip.element.playbackRate = 1;
            clip.lastSeekAt = now;
            drift = 0;
            mode = 'seek';
          } catch {
            mode = 'hold';
          }
        } else if (holdLeft > 0) {
          clip.element.playbackRate = 1;
          mode = 'hold';
        } else if (Math.abs(drift) <= RATE_DEADBAND_SECONDS) {
          clip.element.playbackRate = 1;
          mode = 'locked';
        } else {
          const adj = Math.max(-MAX_RATE_DELTA, Math.min(MAX_RATE_DELTA, drift / RATE_CATCHUP_SECONDS));
          clip.element.playbackRate = 1 - adj;
          mode = 'rate';
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
          ratePercent: clip.element.playbackRate * 100,
          seeking: clip.element.seeking,
          holdMs: holdLeft,
          mode,
        };
      }
    }

    if (!reported) {
      this.lastDebug = null;
    }
  }

  getDebug(): AudioSyncDebug | null {
    return this.lastDebug;
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
