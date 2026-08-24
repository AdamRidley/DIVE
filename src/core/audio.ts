import { AudioClip, Overlay, Scene, Story, StoryAudio } from './types';

export interface NormalizedAudioClip {
  id: string;
  src: string;
  startTime: number;
  endTime: number;
  offset: number;
  volume: number;
  loop: boolean;
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
      const clip = asClip({
        src: overlay.content,
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

interface ManagedClip {
  spec: NormalizedAudioClip;
  element: HTMLAudioElement;
}

const SYNC_SLOP_SECONDS = 0.08;

export class AudioEngine {
  private clips: ManagedClip[] = [];
  private muted = false;
  private masterVolume = 1;
  private unlocked = false;

  configure(specs: NormalizedAudioClip[]): void {
    this.dispose();
    this.clips = specs.map((spec) => {
      const element = new Audio();
      element.preload = 'auto';
      element.src = spec.src;
      element.loop = spec.loop;
      element.volume = spec.volume * this.masterVolume;
      element.muted = this.muted;
      return { spec, element };
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

  sync(storyTimeMs: number, playing: boolean): void {
    for (const clip of this.clips) {
      const active = playing && storyTimeMs >= clip.spec.startTime && storyTimeMs < clip.spec.endTime;
      const mediaTime = (storyTimeMs - clip.spec.startTime + clip.spec.offset) / 1000;

      if (!active) {
        if (!clip.element.paused) {
          clip.element.pause();
        }
        continue;
      }

      if (Number.isFinite(mediaTime) && mediaTime >= 0) {
        if (Math.abs(clip.element.currentTime - mediaTime) > SYNC_SLOP_SECONDS) {
          try {
            clip.element.currentTime = mediaTime;
          } catch {
            // Some browsers reject seeks before metadata; try again next tick.
          }
        }
      }

      clip.element.volume = clip.spec.volume * this.masterVolume;
      clip.element.muted = this.muted;
      if (clip.element.paused) {
        const playAttempt = clip.element.play();
        if (playAttempt) {
          playAttempt.catch(() => { /* autoplay / unlock will retry on next gesture */ });
        }
      }
    }
  }

  dispose(): void {
    for (const clip of this.clips) {
      clip.element.pause();
      clip.element.removeAttribute('src');
      clip.element.load();
    }
    this.clips = [];
    this.unlocked = false;
  }
}
