import { LitElement, html, css } from 'lit';
import { customElement, property, state, query } from 'lit/decorators.js';
import { Sequencer } from '../core/Sequencer';
import { Story, NarrativeState, TimelineSection, Overlay, OverlayAnchor, OverlayAnchorPlacement, OverlayCanonicalAnchor, OverlayPlacementUnit } from '../core/types';
import { IAdapter } from '../core/Adapter';
import { D3ScatterplotAdapter } from '../adapters/D3ScatterplotAdapter';
import { D3MapAdapter } from '../adapters/D3MapAdapter';
import { IframeAdapter } from '../adapters/IframeAdapter';

const toolRegistry: Record<string, new () => IAdapter> = {
  'map': D3MapAdapter,
  'scatterplot': D3ScatterplotAdapter,
};

export function registerTool(name: string, adapterClass: new () => IAdapter) {
  toolRegistry[name] = adapterClass;
}

const timelineSectionPalette = [
  'rgba(92, 153, 255, 0.35)',
  'rgba(255, 170, 83, 0.35)',
  'rgba(122, 211, 124, 0.35)',
  'rgba(242, 118, 168, 0.35)',
  'rgba(172, 149, 255, 0.35)',
  'rgba(102, 214, 196, 0.35)',
];

@customElement('dive-video')
export class DiveVideo extends LitElement {
  @property({ type: String }) src = ''; // URL to the story JSON

  @state() private story: Story | null = null;
  @state() private isPlaying = false;
  @state() private currentTime = 0;
  @state() private activeNarrativeState: NarrativeState | null = null;
  @state() private activeToolId: string | null = null;
  @state() private isFullscreen = false;
  @state() private isUIHidden = false;

  @query('#canvas-container') private canvasContainer!: HTMLElement;

  private sequencer: Sequencer | null = null;
  private activeAdapter: IAdapter | null = null;
  private lastVisualState: any = null;
  private activeScenePauseOnInteract = false;
  private isScrubbing = false;
  private scrubberElement: HTMLElement | null = null;
  private hideUIHandle = 0;

  static styles = css`
    :host {
      display: block;
      position: relative;
      width: 100%;
      height: 100%;
      background: #000;
      overflow: hidden;
      font-family: sans-serif;
    }
    .video-section {
      position: absolute;
      top: 0; left: 0; right: 0;
      bottom: 60px;
      display: flex;
      justify-content: center;
      align-items: center;
      background: #000;
      transition: bottom 0.3s ease-in-out;
    }
    .video-section.fullscreen {
      bottom: 0;
    }
    .video-ratio-wrapper {
      width: 100vw;
      max-width: 100%;
      max-height: 100%;
      aspect-ratio: var(--aspect-ratio, 16/9);
      position: relative;
    }
    #canvas-container {
      width: 100%;
      height: 100%;
      background: #f4f4f4;
      position: absolute;
      top: 0; left: 0; right: 0; bottom: 0;
    }
    /* SVG Styling inside Shadow DOM via adapter requires standard CSS vars or global bleed, but for PoC we'll inject via Lit if needed. D3 inserts inline styles. */

    .overlays {
      position: absolute;
      top: 0; left: 0; right: 0; bottom: 0;
      pointer-events: none; /* Let clicks pass to the canvas underneath */
    }
    .overlay-item {
      position: absolute;
      padding: 20px;
      background: rgba(0,0,0,0.7);
      color: white;
      border-radius: 8px;
      max-width: 40%;
      transition: opacity 0.3s;
    }
    
    .controls {
      position: absolute;
      bottom: 0; left: 0; right: 0;
      height: 60px;
      background: #222;
      display: flex;
      align-items: center;
      padding: 0 10px;
      box-sizing: border-box;
      color: white;
      transition: transform 0.3s ease-in-out;
      z-index: 10;
    }
    .controls.hidden {
      transform: translateY(100%);
    }
    .fullscreen-btn {
      background: transparent;
      padding: 6px;
      margin-left: 10px;
      margin-right: 0;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .fullscreen-btn svg {
      width: 20px;
      height: 20px;
      fill: white;
    }
    button {
      background: #444;
      border: none;
      color: white;
      padding: 8px 16px;
      cursor: pointer;
      border-radius: 4px;
      margin-right: 10px;
    }
    button:hover {
      background: #666;
    }
    .scrubber {
      flex-grow: 1;
      position: relative;
      height: 20px;
      background: #3f3f3f;
      margin: 0 15px;
      cursor: pointer;
      border-radius: 10px;
      overflow: hidden;
    }
    .section-band {
      position: absolute;
      top: 0;
      height: 100%;
      border-right: 1px solid rgba(255, 255, 255, 0.24);
      box-sizing: border-box;
      pointer-events: auto;
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 2;
    }
    .section-label {
      font-size: 10px;
      color: rgba(255, 255, 255, 0.92);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 100%;
      padding: 0 6px;
      text-shadow: 0 1px 1px rgba(0, 0, 0, 0.6);
      pointer-events: none;
    }
    .progress {
      position: absolute;
      top: 0;
      left: 0;
      height: 100%;
      background: rgba(0, 123, 255, 0.55);
      pointer-events: none;
      z-index: 1;
    }
    .scene-marker {
      position: absolute;
      top: 0;
      width: 2px;
      height: 100%;
      background: #fff;
      z-index: 3;
    }
    .time-display {
      font-size: 12px;
      min-width: 80px;
      text-align: right;
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    document.addEventListener('fullscreenchange', this.handleFullscreenChange);
    this.addEventListener('pointermove', this.resetUIHideTimer);
    this.addEventListener('pointerdown', this.resetUIHideTimer);
  }

  protected async firstUpdated() {
    if (this.src) {
      await this.loadStory(this.src);
    }
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.stopScrubTracking();
    document.removeEventListener('fullscreenchange', this.handleFullscreenChange);
    this.removeEventListener('pointermove', this.resetUIHideTimer);
    this.removeEventListener('pointerdown', this.resetUIHideTimer);
    if (this.hideUIHandle) window.clearTimeout(this.hideUIHandle);
  }

  private toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      this.requestFullscreen().catch(err => {
        console.error(`Error attempting to enable fullscreen mode: ${err.message} (${err.name})`);
      });
    } else {
      document.exitFullscreen();
    }
  }

  private handleFullscreenChange = () => {
    this.isFullscreen = !!document.fullscreenElement && document.fullscreenElement === this;
    
    if (this.isFullscreen) {
      // Attempt mobile landscape lock
      if (screen.orientation && screen.orientation.lock) {
        screen.orientation.lock('landscape').catch(() => { /* ignore if not supported or not allowed */ });
      }
      this.resetUIHideTimer();
    } else {
      if (screen.orientation && screen.orientation.unlock) {
        screen.orientation.unlock();
      }
      this.isUIHidden = false;
      if (this.hideUIHandle) window.clearTimeout(this.hideUIHandle);
    }
  }

  private resetUIHideTimer = () => {
    if (!this.isFullscreen) {
      this.isUIHidden = false;
      return;
    }
    this.isUIHidden = false;
    if (this.hideUIHandle) window.clearTimeout(this.hideUIHandle);
    this.hideUIHandle = window.setTimeout(() => {
      this.isUIHidden = true;
    }, 2500);
  }

  private async loadStory(url: string) {
    try {
      const response = await fetch(url);
      this.story = await response.json();
      
      this.sequencer = new Sequencer(this.story!, (state) => {
        this.currentTime = state.time;
        this.activeNarrativeState = state;

        if (state.scene) {
          this.activeScenePauseOnInteract = this.resolvePauseOnInteract(state.scene, state.visualState);
        }
        
        // Handle Scene / Adapter Loading
        if (state.scene && state.scene.id !== this.activeToolId) {
          this.switchTool(state.scene);
        }

        // Pass visual state to active adapter.
        // Most adapters only need keyframe changes, but some tools request per-tick time streaming.
        if (this.activeAdapter && state.visualState) {
          const shouldStreamTime = Boolean((state.visualState as any).streamTime);
          const stateChanged = state.visualState !== this.lastVisualState;

          if (shouldStreamTime || stateChanged) {
            this.activeAdapter.setState(state.visualState, state.time);
          }

          this.lastVisualState = state.visualState;
        }
      });

      // Render and pause on the first frame so the canvas is not blank before Play.
      await this.updateComplete;
      this.lastVisualState = null;
      this.sequencer.seek(0);
      this.notifyAdapterPlaybackState();
      
    } catch (e) {
      console.error("Failed to load DIVE story:", e);
    }
  }

  private async switchTool(scene: Story['scenes'][0]) {
    // Unmount previous
    if (this.activeAdapter) {
      this.activeAdapter.unmount();
      this.activeAdapter = null;
    }
    this.activeToolId = scene.id;
    this.activeScenePauseOnInteract = this.resolvePauseOnInteract(scene, null);

    const tool = scene.tool;

    // Load new adapter
    if (toolRegistry[tool]) {
      const AdapterClass = toolRegistry[tool];
      this.activeAdapter = new AdapterClass();
    } else if (tool.endsWith('.js')) {
      try {
        // Construct an absolute URL to bypass Vite's public directory import restrictions during dev
        const moduleUrl = new URL(tool, window.location.origin).href;
        const module = await import(/* @vite-ignore */ moduleUrl);
        // Look for the exported class, either default or first exported value
        const AdapterClass = module.default || Object.values(module)[0];
        if (typeof AdapterClass === 'function') {
          this.activeAdapter = new (AdapterClass as new () => IAdapter)();
        } else {
          console.warn(`No valid adapter class found in module: ${tool}`);
        }
      } catch (err) {
        console.error(`Failed to dynamically import tool: ${tool}`, err);
      }
    } else if (tool.endsWith('.html') || tool.startsWith('http://') || tool.startsWith('https://')) {
      this.activeAdapter = new IframeAdapter(tool);
    } else {
      console.warn(`No adapter registered for tool: ${tool}`);
    }

    if (this.activeAdapter) {
      if (this.activeAdapter.onInteract) {
        this.activeAdapter.onInteract(() => {
          if (!this.activeScenePauseOnInteract || !this.isPlaying || !this.sequencer) {
            return;
          }

          this.sequencer.pause();
          this.isPlaying = false;
          this.notifyAdapterPlaybackState();
        });
      }

      this.fetchDataAndMount(scene);
    }
  }

  private async fetchDataAndMount(scene: Story['scenes'][0]) {
    try {
      let data: unknown = undefined;
      const shouldSendData = scene.sendData !== false && typeof scene.data !== 'undefined';

      if (shouldSendData) {
        const dataRef = scene.data;
        const isExternalDataUrl = typeof dataRef === 'string' && /^(https?:\/\/|\/|\.\/|\.\.\/)/.test(dataRef);

        if (isExternalDataUrl) {
          const dataUrl = new URL(dataRef as string, window.location.origin).href;
          const res = await fetch(dataUrl);
          data = await res.json();
        } else {
          data = dataRef;
        }
      }

      this.activeAdapter?.mount(this.canvasContainer, data);
      this.notifyAdapterPlaybackState();
    } catch (e) {
      console.error("Failed to load data for tool:", e);
    }
  }

  private notifyAdapterPlaybackState() {
    if (this.activeAdapter?.setPlaybackState) {
      this.activeAdapter.setPlaybackState(this.isPlaying, this.currentTime);
    }
  }

  private togglePlay() {
    if (!this.sequencer) return;
    
    if (this.isPlaying) {
      this.sequencer.pause();
      this.isPlaying = false;
      this.notifyAdapterPlaybackState();
      // In Explore Mode -> Let user interact freely
      // The canvas container pointer-events could be toggled here.
    } else {
      // Snapback will happen naturally because we reset the lastVisualState
      this.lastVisualState = null;
      this.sequencer.play();
      this.isPlaying = true;
      this.notifyAdapterPlaybackState();
    }
  }

  private seekFromScrubberClientX(clientX: number, scrubber: HTMLElement) {
    if (!this.sequencer || !this.story) return;

    const rect = scrubber.getBoundingClientRect();
    const percent = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const timeMs = percent * this.story.duration;

    this.lastVisualState = null; // Force snapback on scrub
    this.sequencer.seek(timeMs);
  }

  private handleScrubPointerDown(e: PointerEvent) {
    if (!(e.currentTarget instanceof HTMLElement)) {
      return;
    }

    this.isScrubbing = true;
    this.scrubberElement = e.currentTarget;
    this.seekFromScrubberClientX(e.clientX, this.scrubberElement);

    window.addEventListener('pointermove', this.handleGlobalPointerMove);
    window.addEventListener('pointerup', this.handleGlobalPointerUp);
  }

  private handleGlobalPointerMove = (e: PointerEvent) => {
    if (!this.isScrubbing || !this.scrubberElement) {
      return;
    }

    this.seekFromScrubberClientX(e.clientX, this.scrubberElement);
  };

  private handleGlobalPointerUp = () => {
    this.stopScrubTracking();
  };

  private stopScrubTracking() {
    this.isScrubbing = false;
    this.scrubberElement = null;
    window.removeEventListener('pointermove', this.handleGlobalPointerMove);
    window.removeEventListener('pointerup', this.handleGlobalPointerUp);
  }

  private formatTime(ms: number) {
    const totalSeconds = Math.floor(ms / 1000);
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  private resolvePauseOnInteract(scene: Story['scenes'][0], visualState: any) {
    if (visualState && typeof visualState.pauseOnInteract === 'boolean') {
      return visualState.pauseOnInteract;
    }

    return Boolean(scene.pauseOnInteract);
  }

  private getTimelineSections(): TimelineSection[] {
    if (!this.story) {
      return [];
    }

    if (Array.isArray(this.story.timelineSections) && this.story.timelineSections.length > 0) {
      return [...this.story.timelineSections]
        .filter((section) => Number.isFinite(section.startTime) && Number.isFinite(section.endTime) && section.endTime > section.startTime)
        .sort((a, b) => a.startTime - b.startTime);
    }

    return this.story.scenes.map((scene) => ({
      id: scene.id,
      label: scene.id,
      startTime: scene.startTime,
      endTime: scene.endTime,
      description: `Tool: ${scene.id}`,
    }));
  }

  private normalizePlacementUnit(unit: OverlayPlacementUnit | undefined): OverlayPlacementUnit {
    return unit === '%' ? '%' : 'px';
  }

  private parsePlacementLength(value: unknown, unit: OverlayPlacementUnit | undefined): string {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return `${value}${this.normalizePlacementUnit(unit)}`;
    }

    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) {
        return `0${this.normalizePlacementUnit(unit)}`;
      }

      const explicitUnitMatch = trimmed.match(/^(-?\d*\.?\d+)(px|%)$/i);
      if (explicitUnitMatch) {
        const numericValue = Number(explicitUnitMatch[1]);
        const explicitUnit = explicitUnitMatch[2].toLowerCase();
        if (Number.isFinite(numericValue) && (explicitUnit === 'px' || explicitUnit === '%')) {
          return `${numericValue}${explicitUnit}`;
        }
      }

      const numericValue = Number(trimmed);
      if (Number.isFinite(numericValue)) {
        return `${numericValue}${this.normalizePlacementUnit(unit)}`;
      }
    }

    return `0${this.normalizePlacementUnit(unit)}`;
  }

  private resolveOverlayOffsets(placement: OverlayAnchorPlacement | undefined) {
    let offsetX = '0px';
    let offsetY = '0px';

    if (typeof placement?.offset !== 'undefined') {
      if (typeof placement.offset === 'string') {
        const parts = placement.offset.trim().split(/\s+/).filter(Boolean);

        if (parts.length === 1) {
          const shared = this.parsePlacementLength(parts[0], placement.offsetUnit);
          offsetX = shared;
          offsetY = shared;
        } else if (parts.length >= 2) {
          offsetX = this.parsePlacementLength(parts[0], placement.offsetXUnit ?? placement.offsetUnit);
          offsetY = this.parsePlacementLength(parts[1], placement.offsetYUnit ?? placement.offsetUnit);
        }
      } else {
        const shared = this.parsePlacementLength(placement.offset, placement.offsetUnit);
        offsetX = shared;
        offsetY = shared;
      }
    }

    if (typeof placement?.offsetX !== 'undefined') {
      offsetX = this.parsePlacementLength(placement.offsetX, placement.offsetXUnit ?? placement.offsetUnit);
    }

    if (typeof placement?.offsetY !== 'undefined') {
      offsetY = this.parsePlacementLength(placement.offsetY, placement.offsetYUnit ?? placement.offsetUnit);
    }

    return { offsetX, offsetY };
  }

  private normalizeOverlayAnchor(anchor: OverlayAnchor): OverlayCanonicalAnchor {
    switch (anchor) {
      case 'top':
        return 'topCenter';
      case 'bottom':
        return 'bottomCenter';
      case 'left':
        return 'centerLeft';
      case 'right':
        return 'centerRight';
      default:
        return anchor;
    }
  }

  private getAnchorLayout(anchor: OverlayCanonicalAnchor) {
    switch (anchor) {
      case 'topLeft':
        return { xPercent: 0, yPercent: 0, translateXPercent: 0, translateYPercent: 0 };
      case 'topCenter':
        return { xPercent: 50, yPercent: 0, translateXPercent: -50, translateYPercent: 0 };
      case 'topRight':
        return { xPercent: 100, yPercent: 0, translateXPercent: -100, translateYPercent: 0 };
      case 'centerLeft':
        return { xPercent: 0, yPercent: 50, translateXPercent: 0, translateYPercent: -50 };
      case 'center':
        return { xPercent: 50, yPercent: 50, translateXPercent: -50, translateYPercent: -50 };
      case 'centerRight':
        return { xPercent: 100, yPercent: 50, translateXPercent: -100, translateYPercent: -50 };
      case 'bottomLeft':
        return { xPercent: 0, yPercent: 100, translateXPercent: 0, translateYPercent: -100 };
      case 'bottomCenter':
        return { xPercent: 50, yPercent: 100, translateXPercent: -50, translateYPercent: -100 };
      case 'bottomRight':
        return { xPercent: 100, yPercent: 100, translateXPercent: -100, translateYPercent: -100 };
      default:
        return { xPercent: 50, yPercent: 0, translateXPercent: -50, translateYPercent: 0 };
    }
  }

  private getOverlayPlacementStyle(overlay: Overlay): string {
    const placement = overlay.placement as Overlay['placement'] | undefined;

    if (placement?.mode === 'absolute') {
      const x = this.parsePlacementLength(placement.x, placement.xUnit);
      const y = this.parsePlacementLength(placement.y, placement.yUnit);
      return `left: ${x}; top: ${y}; transform: none;`;
    }

    const anchorPlacement = placement as OverlayAnchorPlacement | undefined;
    const anchor = this.normalizeOverlayAnchor(anchorPlacement?.anchor || 'topCenter');
    const layout = this.getAnchorLayout(anchor);
    const { offsetX, offsetY } = this.resolveOverlayOffsets(anchorPlacement);

    return [
      `left: calc(${layout.xPercent}% + ${offsetX})`,
      `top: calc(${layout.yPercent}% + ${offsetY})`,
      `transform: translate(${layout.translateXPercent}%, ${layout.translateYPercent}%)`,
    ].join('; ');
  }

  render() {
    if (!this.story) {
      return html`<div>Loading Story...</div>`;
    }

    const duration = this.story.duration;
    const percent = (this.currentTime / duration) * 100;
    const timelineSections = this.getTimelineSections();
    const activeSceneData = this.story.scenes.find((scene) => scene.id === this.activeToolId)?.data;
    const visibleOverlays = (this.activeNarrativeState?.activeOverlays || []).filter((overlay) => {
      if (!this.isPlaying && overlay.hideWhenPaused) {
        return false;
      }
      return true;
    });

    const aspectRatioRaw = this.story?.aspectRatio || '16:9';
    const aspectRatioCSS = aspectRatioRaw.replace(':', '/');

    return html`
      <div class="video-section ${this.isFullscreen ? 'fullscreen' : ''}">
        <div class="video-ratio-wrapper" style="--aspect-ratio: ${aspectRatioCSS}">
          <div id="canvas-container"></div>
          
          <!-- Overlay Layer -->
          <div class="overlays">
            ${visibleOverlays.map(o => html`
              <div class="overlay-item" style=${this.getOverlayPlacementStyle(o)}>
                ${o.type === 'text' ? html`<p>${o.content}</p>` : html`<img src="${o.content}" width="100%" />`}
              </div>
            `)}
          </div>
        </div>
      </div>

      <!-- Controls Layer -->
      <div class="controls ${this.isFullscreen && this.isUIHidden ? 'hidden' : ''}">
        <button @click=${this.togglePlay}>${this.isPlaying ? 'Pause' : 'Play'}</button>
        
        <div class="scrubber" @pointerdown=${this.handleScrubPointerDown}>
          ${timelineSections.map((section, index) => {
            const startPercent = (section.startTime / duration) * 100;
            const widthPercent = ((section.endTime - section.startTime) / duration) * 100;
            const color = section.color || timelineSectionPalette[index % timelineSectionPalette.length];
            const tooltip = section.description ? `${section.label}: ${section.description}` : section.label;
            const showLabel = widthPercent >= 8;

            return html`
              <div
                class="section-band"
                style="left: ${startPercent}%; width: ${widthPercent}%; background: ${color};"
                title="${tooltip}"
              >
                ${showLabel ? html`<span class="section-label">${section.label}</span>` : ''}
              </div>
            `;
          })}

          <div class="progress" style="width: ${percent}%"></div>
          
          <!-- Scene Markers -->
          ${this.story.scenes.map(s => {
            const pos = (s.startTime / duration) * 100;
            return html`<div class="scene-marker" style="left: ${pos}%" title="${s.id}"></div>`;
          })}
        </div>

        <div class="time-display">
          ${this.formatTime(this.currentTime)} / ${this.formatTime(duration)}
        </div>

        <button class="fullscreen-btn" @click=${this.toggleFullscreen} title="Toggle Fullscreen" aria-label="Toggle Fullscreen">
          <svg viewBox="0 0 24 24">
            ${this.isFullscreen 
              ? html`<path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"/>` 
              : html`<path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/>`}
          </svg>
        </button>
      </div>
      
      <!-- Accessibility Layer: Parallel DOM (Hidden visually) -->
      <div aria-live="polite" class="sr-only" style="position: absolute; width: 1px; height: 1px; overflow: hidden;">
        ${visibleOverlays.filter(o => o.type === 'text').map(o => o.content).join(' ')}
      </div>
      
      <!-- Screen Reader Data Context -->
      <div class="sr-only" style="position: absolute; width: 1px; height: 1px; overflow: hidden;">
        <h3>${this.activeToolId} Data</h3>
        ${!this.isPlaying ? html`
          <table>
            <caption>Current data view for exploration</caption>
            <tbody>
              ${Array.isArray(activeSceneData) 
                ? (activeSceneData as unknown as any[]).map((d: any) => html`
                <tr>${Object.entries(d).map(([k, v]) => html`<td>${k}: ${v}</td>`)}</tr>
              `) : html`<tr><td>Data loading or external</td></tr>`}
            </tbody>
          </table>
        ` : ''}
      </div>
    `;
  }
}
