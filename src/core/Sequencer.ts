import { Story, Scene, NarrativeState } from './types';

export type SequencerCallback = (state: NarrativeState) => void;

export class Sequencer {
  private story: Story;
  private currentTime: number = 0; // ms
  private isPlaying: boolean = false;
  private lastRafTime: number = 0;
  private rafId: number = 0;
  
  private onTick?: SequencerCallback;

  constructor(story: Story, onTick?: SequencerCallback) {
    this.story = story;
    this.onTick = onTick;
  }

  public play() {
    if (this.isPlaying) return;
    this.isPlaying = true;
    this.lastRafTime = performance.now();
    this.rafId = requestAnimationFrame(this.tick.bind(this));
  }

  public pause() {
    this.isPlaying = false;
    cancelAnimationFrame(this.rafId);
  }

  public seek(timeMs: number) {
    this.currentTime = Math.max(0, Math.min(timeMs, this.story.duration));
    this.updateState();
  }

  public getCurrentTime() {
    return this.currentTime;
  }

  public getDuration() {
    return this.story.duration;
  }

  private tick(now: number) {
    if (!this.isPlaying) return;

    const delta = now - this.lastRafTime;
    this.lastRafTime = now;
    
    // Guard against occasional negative first-frame deltas from RAF timestamp jitter.
    this.currentTime = Math.max(0, this.currentTime + delta);
    
    if (this.currentTime >= this.story.duration) {
      this.currentTime = this.story.duration;
      this.pause();
      // maybe trigger an onEnd event
    }

    this.updateState();

    if (this.isPlaying) {
      this.rafId = requestAnimationFrame(this.tick.bind(this));
    }
  }

  private updateState() {
    if (!this.onTick) return;

    const currentScene = this.getCurrentScene();
    if (!currentScene) {
      // Out of bounds
      this.onTick({
        time: this.currentTime,
        visualState: null,
        activeOverlays: []
      });
      return;
    }

    const { visualState, activeOverlays } = this.calculateSceneState(currentScene, this.currentTime - currentScene.startTime);

    this.onTick({
      time: this.currentTime,
      scene: currentScene,
      visualState,
      activeOverlays
    });
  }

  private getCurrentScene(): Scene | undefined {
    return this.story.scenes.find(s => this.currentTime >= s.startTime && this.currentTime <= s.endTime);
  }

  private calculateSceneState(scene: Scene, sceneTime: number) {
    // 1. Calculate visual state from keyframes
    let visualState = {};
    if (scene.keyframes.length > 0) {
      // Find the last keyframe BEFORE or EQUAL to current sceneTime
      let activeKeyframe = scene.keyframes[0];
      for (const kf of scene.keyframes) {
        if (kf.time <= sceneTime) {
          activeKeyframe = kf;
        } else {
          break; // Since they should be sorted chronologically
        }
      }
      
      // Note: In a full implementation, we would interpolate between activeKeyframe and the NEXT keyframe based on time.
      // For this PoC, we send the target keyframe state and let the D3 Adapter handle the tween/transition natively if it wants.
      // Or we can just snapshot it. We'll pass the snapshot state.
      visualState = activeKeyframe.state;
    }

    // 2. Determine active overlays
    const activeOverlays = scene.overlays.filter(o => 
      sceneTime >= o.time && sceneTime < (o.time + o.duration)
    );

    return { visualState, activeOverlays };
  }
}
