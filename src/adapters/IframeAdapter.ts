
import { IAdapter } from '../core/Adapter';

export class IframeAdapter implements IAdapter {
  private iframe: HTMLIFrameElement | null = null;
  private container: HTMLElement | null = null;
  private url: string;

  constructor(url: string) {
    this.url = url;
  }

  mount(container: HTMLElement, data: any): void {
    this.container = container;
    this.iframe = document.createElement('iframe');
    this.iframe.src = this.url;
    this.iframe.style.width = '100%';
    this.iframe.style.height = '100%';
    this.iframe.style.border = 'none';
    this.container.appendChild(this.iframe);

    // After load, pass the initial data down
    this.iframe.onload = () => {
      this.iframe?.contentWindow?.postMessage({
        type: 'DIVE_INIT',
        data: data
      }, '*');
    };
  }

  unmount(): void {
    if (this.iframe && this.container) {
      this.container.removeChild(this.iframe);
      this.iframe = null;
    }
  }

  setState(state: any, time: number): void {
    if (this.iframe && this.iframe.contentWindow) {
      this.iframe.contentWindow.postMessage({
        type: 'DIVE_STATE',
        state: state,
        time: time
      }, '*');
    }
  }
}

