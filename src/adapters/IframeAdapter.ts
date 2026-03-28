
import { IAdapter } from '../core/Adapter';

export class IframeAdapter implements IAdapter {
  private iframe: HTMLIFrameElement | null = null;
  private container: HTMLElement | null = null;
  private url: string;
  private isLoaded = false;
  private initData: any = undefined;
  private pendingState: any = null;
  private pendingTime = 0;
  private pendingPlaybackIsPlaying: boolean | null = null;
  private pendingPlaybackTime = 0;
  private interactCallback: (() => void) | null = null;

  private messageHandler = (event: MessageEvent) => {
    if (!this.iframe || event.source !== this.iframe.contentWindow) {
      return;
    }

    if (event.data?.type === 'DIVE_INTERACT') {
      this.interactCallback?.();
    }
  };

  constructor(url: string) {
    this.url = url;
  }

  mount(container: HTMLElement, data: any): void {
    this.container = container;
    this.initData = data;
    this.isLoaded = false;

    this.iframe = document.createElement('iframe');
    this.iframe.src = this.url;
    this.iframe.style.width = '100%';
    this.iframe.style.height = '100%';
    this.iframe.style.border = 'none';
    this.container.appendChild(this.iframe);
    window.addEventListener('message', this.messageHandler);

    // After load, pass the initial data down
    this.iframe.onload = () => {
      this.isLoaded = true;
      const targetWindow = this.iframe?.contentWindow;
      if (!targetWindow) return;

      if (typeof this.initData !== 'undefined') {
        targetWindow.postMessage({
          type: 'DIVE_INIT',
          data: this.initData
        }, '*');
      }

      // If timeline state was pushed before iframe load completed, replay the latest state now.
      if (this.pendingState !== null) {
        targetWindow.postMessage({
          type: 'DIVE_STATE',
          state: this.pendingState,
          time: this.pendingTime
        }, '*');
      }

      if (this.pendingPlaybackIsPlaying !== null) {
        targetWindow.postMessage({
          type: 'DIVE_PLAYBACK',
          isPlaying: this.pendingPlaybackIsPlaying,
          time: this.pendingPlaybackTime
        }, '*');
      }
    };
  }

  unmount(): void {
    if (this.iframe && this.container) {
      this.container.removeChild(this.iframe);
      this.iframe = null;
    }

    window.removeEventListener('message', this.messageHandler);

    this.isLoaded = false;
    this.initData = undefined;
    this.pendingState = null;
    this.pendingTime = 0;
    this.pendingPlaybackIsPlaying = null;
    this.pendingPlaybackTime = 0;
  }

  setState(state: any, time: number): void {
    // Always keep latest state, even before iframe is created/loaded.
    this.pendingState = state;
    this.pendingTime = time;

    if (!this.iframe) return;

    if (this.isLoaded && this.iframe.contentWindow) {
      this.iframe.contentWindow.postMessage({
        type: 'DIVE_STATE',
        state: state,
        time: time
      }, '*');
      return;
    }
  }

  onInteract(callback: () => void): void {
    this.interactCallback = callback;
  }

  setPlaybackState(isPlaying: boolean, timeMs: number): void {
    this.pendingPlaybackIsPlaying = isPlaying;
    this.pendingPlaybackTime = timeMs;

    if (this.isLoaded && this.iframe?.contentWindow) {
      this.iframe.contentWindow.postMessage({
        type: 'DIVE_PLAYBACK',
        isPlaying,
        time: timeMs,
      }, '*');
    }
  }
}

