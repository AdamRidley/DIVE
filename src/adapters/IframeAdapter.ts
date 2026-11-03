
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
  private pendingLang: string | null = null;
  private interactCallback: (() => void) | null = null;
  private languageCallback: ((lang: string) => void) | null = null;
  private navigationCallback: ((sceneId: string, play: boolean) => void) | null = null;
  private readyCallback: (() => void) | null = null;
  private ready = false;
  private preloading = false;

  private messageHandler = (event: MessageEvent) => {
    if (!this.iframe || event.source !== this.iframe.contentWindow) {
      return;
    }

    if (event.data?.type === 'DIVE_INTERACT') {
      this.interactCallback?.();
    }
    if (event.data?.type === 'DIVE_LANG' && typeof event.data.lang === 'string') {
      this.languageCallback?.(event.data.lang);
    }
    if (event.data?.type === 'DIVE_NAVIGATE' && typeof event.data.sceneId === 'string') {
      this.navigationCallback?.(event.data.sceneId, event.data.play === true);
    }
    if (event.data?.type === 'DIVE_READY') {
      this.syncPreloading();
      this.ready = true;
      this.readyCallback?.();
    }
  };

  constructor(url: string) {
    this.url = url;
  }

  mount(container: HTMLElement, data: any): void {
    this.container = container;
    this.initData = data;
    this.isLoaded = false;
    this.ready = false;

    this.iframe = document.createElement('iframe');
    this.iframe.style.width = '100%';
    this.iframe.style.height = '100%';
    this.iframe.style.border = 'none';
    window.addEventListener('message', this.messageHandler);

    // After load, pass the initial data down
    this.iframe.onload = () => {
      this.isLoaded = true;
      this.syncPreloading();
      const targetWindow = this.iframe?.contentWindow;
      if (!targetWindow) return;

      targetWindow.postMessage({
        type: 'DIVE_INIT',
        data: this.initData,
        lang: this.pendingLang,
      }, '*');

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

      if (this.pendingLang) {
        targetWindow.postMessage({
          type: 'DIVE_LANG',
          lang: this.pendingLang,
        }, '*');
      }
    };
    this.iframe.src = this.url;
    this.container.appendChild(this.iframe);
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
    this.pendingLang = null;
    this.preloading = false;
    this.ready = false;
    this.readyCallback = null;
    this.navigationCallback = null;
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

  setLanguage(lang: string): void {
    this.pendingLang = lang;
    if (this.isLoaded && this.iframe?.contentWindow) {
      this.iframe.contentWindow.postMessage({
        type: 'DIVE_LANG',
        lang,
      }, '*');
    }
  }

  onLanguage(callback: (lang: string) => void): void {
    this.languageCallback = callback;
  }

  onNavigate(callback: (sceneId: string, play: boolean) => void): void {
    this.navigationCallback = callback;
  }

  onReady(callback: () => void): void {
    this.readyCallback = callback;
    if (this.ready) {
      callback();
    }
  }

  hasLoaded(): boolean {
    return this.isLoaded;
  }

  setPreloading(preloading: boolean): void {
    this.preloading = preloading;
    this.syncPreloading();
  }

  private syncPreloading(): void {
    const doc = this.iframe?.contentDocument;
    if (!doc?.head) return;
    let style = doc.querySelector<HTMLStyleElement>('style[data-dive-preloading]');
    if (this.preloading && !style) {
      style = doc.createElement('style');
      style.setAttribute('data-dive-preloading', '');
      style.textContent = '*,*::before,*::after{animation-play-state:paused!important}';
      doc.head.appendChild(style);
    } else if (!this.preloading) {
      style?.remove();
    }
  }
}
