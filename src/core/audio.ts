import { AudioClip, AudioRole, Overlay, Scene, Story, StoryAudio } from './types';
import { resolveLocalized } from './locale';
import {
  AudioSyncMode,
  AudioSyncPhase,
  planAudioSync,
} from './audio-sync-plan';

function planWantsPlay(
  mode: AudioSyncMode,
  holdMs: number,
  seeking: boolean,
): boolean {
  return mode === 'locked' || (mode === 'hold' && holdMs === 0 && !seeking);
}

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
  lastAssigned: number;
  phase: AudioSyncPhase;
  clockMoved: boolean;
}

export class AudioEngine {
  private clips: ManagedClip[] = [];
  private muted = false;
  private masterVolume = 1;
  private unlocked = false;
  private holdingStory = false;

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
        lastAssigned: 0,
        phase: 'locked',
        clockMoved: false,
      };
    });
  }

  get hasAudio(): boolean {
    return this.clips.length > 0;
  }

  get isMuted(): boolean {
    return this.muted;
  }

  get isHoldingStory(): boolean {
    return this.holdingStory;
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
    this.holdingStory = false;

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
        if (clip.element.playbackRate !== 1) {
          clip.element.playbackRate = 1;
        }
        continue;
      }

      let mode: AudioSyncMode = 'locked';
      let holdLeft = 0;

      if (Number.isFinite(mediaTime) && mediaTime >= 0 && clip.element.readyState >= 1) {
        let audioTime = clip.element.currentTime;
        let drift = audioTime - mediaTime;
        if (clip.spec.loop && Number.isFinite(duration) && duration > 0) {
          if (drift > duration / 2) {
            audioTime -= duration;
          } else if (drift < -duration / 2) {
            audioTime += duration;
          }
        }

        const plan = planAudioSync({
          now,
          mediaTime,
          audioTime,
          seeking: clip.element.seeking,
          readyState: clip.element.readyState,
          hard: Boolean(options.hard),
          phase: clip.phase,
          lastSeekAt: clip.lastSeekAt,
          lastAssigned: clip.lastAssigned,
          clockMoved: clip.clockMoved,
        });

        clip.phase = plan.phase;
        clip.lastSeekAt = plan.lastSeekAt;
        clip.lastAssigned = plan.lastAssigned;
        clip.clockMoved = plan.clockMoved;
        mode = plan.mode;
        holdLeft = plan.holdMs;
        if (plan.holdStory) {
          this.holdingStory = true;
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
          } catch {
            mode = 'hold';
          }
        }
      }

      clip.element.volume = clip.spec.volume * this.masterVolume;
      clip.element.muted = this.muted;
      const shouldPlay = planWantsPlay(mode, holdLeft, clip.element.seeking);
      if (!shouldPlay && !clip.element.paused) {
        clip.element.pause();
      }
      if (shouldPlay && clip.element.paused && !clip.playLock) {
        const playAttempt = clip.element.play();
        if (playAttempt) {
          clip.playLock = playAttempt.then(() => {
            clip.playLock = null;
          }).catch(() => {
            clip.playLock = null;
          });
        }
      }
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
  }
}
