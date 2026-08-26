import { LitElement, html, css } from 'lit';
import { customElement, property, state, query } from 'lit/decorators.js';
import { Sequencer } from '../core/Sequencer';
import { Story, NarrativeState, TimelineSection, Overlay, OverlayAnchor, OverlayAnchorPlacement, OverlayCanonicalAnchor, OverlayPlacementUnit, CaptionCue, LanguageOption } from '../core/types';
import { IAdapter } from '../core/Adapter';
import { D3ScatterplotAdapter } from '../adapters/D3ScatterplotAdapter';
import { D3MapAdapter } from '../adapters/D3MapAdapter';
import { IframeAdapter } from '../adapters/IframeAdapter';

import { aspectCss, containSize, parseAspectRatio } from '../core/aspect';
import { stageSize } from '../core/stage';
import { AudioEngine, AudioSyncDebug, collectStoryAudio, filterAudioClips } from '../core/audio';
import { captionTracksForLocale, cuesAtTime, resolveCaptionTracks, ResolvedCaptionTrack } from '../core/captions';
import { filesForScene, loadDivePack, looksLikeDiveUrl, openDivePack, shouldLoadAsDive, DivePackSession } from '../core/dive-pack';
import { listedLanguages, resolveLocalized, resolvePlayerLanguage, storeLanguage } from '../core/locale';
import { readDiveUrlState, writeDiveUrlState } from '../core/url-state';
import { resolveUiMode } from '../core/ui-mode';

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
  @property({ type: String, attribute: 'ui-mode' }) uiMode = '';

  @state() private story: Story | null = null;
  @state() private isPlaying = false;
  @state() private currentTime = 0;
  @state() private activeNarrativeState: NarrativeState | null = null;
  @state() private activeToolId: string | null = null;
  @state() private isFullscreen = false;
  @state() private isUIHidden = false;
  @state() private isMuted = false;
  @state() private captionsEnabled = true;
  @state() private descriptionsEnabled = false;
  @state() private activeCues: CaptionCue[] = [];
  @state() private playerLang = 'en';
  @state() private settingsOpen = false;
  @state() private chaptersOpen = false;
  @state() private ended = false;
  @state() private hasStarted = false;
  @state() private sceneReady = true;
  @state() private toolFading = false;
  @state() private audioDebugEnabled = false;
  @state() private audioDebug: AudioSyncDebug | null = null;
  private playWhenReady = false;
  private toolReadyTimer = 0;
  private audioHardSeek = false;

  @query('#canvas-container') private canvasContainer!: HTMLElement;
  @query('.video-ratio-wrapper') private ratioWrapper?: HTMLElement;
  @query('.video-section') private videoSection?: HTMLElement;

  private sequencer: Sequencer | null = null;
  private activeAdapter: IAdapter | null = null;
  private lastVisualState: any = null;
  private activeScenePauseOnInteract = false;
  private isScrubbing = false;
  private scrubberElement: HTMLElement | null = null;
  private hideUIHandle = 0;
  private audioEngine = new AudioEngine();
  private captionTracks: ResolvedCaptionTrack[] = [];
  private storyBaseUrl = '';
  private packSession: DivePackSession | null = null;
  private urlSyncHandle = 0;
  private allAudioSpecs: ReturnType<typeof collectStoryAudio> = [];
  private stageObserver: ResizeObserver | null = null;

  static styles = css`
    :host {
      display: block;
      position: relative;
      width: 100%;
      max-width: 100%;
      height: auto;
      aspect-ratio: var(--aspect-ratio, 9 / 16);
      background: #000;
      overflow: hidden;
      font-family: sans-serif;
      outline: none;
    }
    :host(:fullscreen) {
      width: 100%;
      height: 100%;
      aspect-ratio: auto;
    }
    :host([ui-mode="inset"]) {
      display: grid;
      grid-template-rows: 48px minmax(0, 1fr) 56px;
      background: #111214;
    }
    :host([ui-mode="inset"]:fullscreen) {
      grid-template-rows: 52px minmax(0, 1fr) 64px;
    }
    .video-section {
      position: absolute;
      inset: 0;
      display: grid;
      place-items: center;
      background: #000;
      container-type: size;
      container-name: stage;
    }
    :host([ui-mode="inset"]) .video-section {
      position: relative;
      inset: auto;
      min-width: 0;
      min-height: 0;
      width: 100%;
      height: 100%;
    }
    .video-ratio-wrapper {
      position: relative;
      overflow: hidden;
      flex: none;
      background: #000;
      aspect-ratio: var(--aspect-ratio, 9 / 16);
      max-width: 100%;
      max-height: 100%;
    }
    #canvas-container {
      width: var(--stage-w, 1920px);
      height: var(--stage-h, 1080px);
      background: #f4f4f4;
      position: absolute;
      top: 0;
      left: 0;
      transform-origin: 0 0;
      transform: scale(var(--stage-scale, 1));
      transition: opacity 0.28s ease;
    }
    .play-catcher {
      position: absolute;
      inset: 0;
      z-index: 8;
      background: transparent;
    }
    #canvas-container.fading {
      opacity: 0;
    }
    .poster {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      object-fit: cover;
      z-index: 4;
      pointer-events: none;
    }
    .end-screen,
    .drawer {
      position: absolute;
      z-index: 12;
      color: #fff;
      background: rgba(10, 10, 12, 0.88);
    }
    .end-screen {
      inset: 0;
      display: grid;
      place-items: center;
      text-align: center;
      gap: 12px;
      padding: 24px;
    }
    .end-screen h2 {
      margin: 0;
      font-size: 1.4rem;
    }
    .drawer {
      position: absolute;
      z-index: 12;
      min-width: 180px;
      max-width: min(280px, 80%);
      max-height: 55%;
      overflow: auto;
      border-radius: 8px;
      padding: 10px 0;
      box-shadow: 0 8px 24px rgba(0,0,0,0.4);
    }
    .drawer.chapters {
      left: 10px;
      top: 52px;
    }
    .drawer.settings {
      right: 10px;
      top: 52px;
    }
    .drawer h3 {
      margin: 0 12px 8px;
      font-size: 11px;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      opacity: 0.7;
    }
    .drawer button,
    .drawer label {
      display: block;
      width: 100%;
      text-align: left;
      background: transparent;
      border: 0;
      color: #fff;
      padding: 8px 12px;
      margin: 0;
      border-radius: 0;
      font-size: 13px;
    }
    .drawer button:hover,
    .drawer label:hover,
    .drawer button[aria-current="true"] {
      background: rgba(255,255,255,0.12);
    }
    .drawer label {
      display: flex;
      align-items: center;
      gap: 8px;
      cursor: pointer;
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
    .audio-debug {
      position: absolute;
      top: 8px;
      left: 8px;
      z-index: 9;
      pointer-events: none;
      font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      color: #d7ffe4;
      background: rgba(0, 0, 0, 0.72);
      border: 1px solid rgba(215, 255, 228, 0.25);
      border-radius: 6px;
      padding: 6px 8px;
      white-space: pre;
      text-align: left;
    }
    .captions {
      position: absolute;
      left: 6%;
      right: 6%;
      bottom: 76px;
      text-align: center;
      pointer-events: none;
      z-index: 5;
    }
    .caption-cue {
      display: inline-block;
      background: rgba(0, 0, 0, 0.75);
      color: #fff;
      padding: 4px 10px;
      border-radius: 4px;
      font-size: clamp(14px, 3.2cqw, 20px);
      line-height: 1.35;
      max-width: 100%;
      white-space: pre-line;
    }
    .buffer-spinner {
      position: absolute;
      inset: 0;
      display: grid;
      place-items: center;
      background: rgba(0, 0, 0, 0.35);
      z-index: 6;
      pointer-events: none;
    }
    .buffer-spinner::after {
      content: '';
      width: 36px;
      height: 36px;
      border: 3px solid rgba(255, 255, 255, 0.25);
      border-top-color: #fff;
      border-radius: 50%;
      animation: dive-spin 0.8s linear infinite;
    }
    @keyframes dive-spin {
      to { transform: rotate(360deg); }
    }

    .controls {
      position: absolute;
      bottom: 0; left: 0; right: 0;
      min-height: 56px;
      background: linear-gradient(transparent, rgba(0, 0, 0, 0.82));
      display: flex;
      align-items: center;
      padding: 10px 10px 8px;
      box-sizing: border-box;
      color: white;
      transition: opacity 0.25s ease, transform 0.25s ease;
      z-index: 10;
    }
    .controls.hidden,
    .corner-btn.hidden {
      opacity: 0;
      pointer-events: none;
    }
    .controls.hidden {
      transform: translateY(40%);
    }
    .chrome-top {
      display: contents;
    }
    :host([ui-mode="inset"]) .chrome-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 8px;
      background: #111214;
      z-index: 11;
    }
    :host([ui-mode="inset"]) .controls {
      position: relative;
      bottom: auto;
      left: auto;
      right: auto;
      min-height: 56px;
      background: #111214;
      transform: none;
      opacity: 1;
      pointer-events: auto;
    }
    :host([ui-mode="inset"]) .corner-btn,
    :host([ui-mode="inset"]) button.icon-btn.corner-btn {
      position: relative;
      top: auto;
      left: auto;
      right: auto;
      background: rgba(255, 255, 255, 0.08);
    }
    :host([ui-mode="inset"]) .drawer.chapters {
      left: 8px;
      top: 50px;
    }
    :host([ui-mode="inset"]) .drawer.settings {
      right: 8px;
      top: 50px;
    }
    .corner-btn {
      position: absolute;
      top: 10px;
      z-index: 11;
      width: 36px;
      height: 36px;
      margin: 0;
      padding: 0;
      flex-shrink: 0;
      background: rgba(0, 0, 0, 0.45);
      border-radius: 8px;
      transition: opacity 0.25s ease;
    }
    .corner-btn.chapters { left: 10px; }
    .corner-btn.settings { right: 10px; }
    button.icon-btn {
      background: transparent;
      color: #fff;
      padding: 0;
      margin: 0 0 0 6px;
      width: 40px;
      height: 40px;
      min-width: 40px;
      border: 0;
      border-radius: 8px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      cursor: pointer;
    }
    button.icon-btn:hover {
      background: rgba(255, 255, 255, 0.16);
    }
    button.icon-btn svg {
      width: 24px;
      height: 24px;
      fill: #fff;
      display: block;
      flex: none;
    }
    button.icon-btn.corner-btn {
      position: absolute;
      margin: 0;
      background: rgba(0, 0, 0, 0.55);
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
    this.addEventListener('keydown', this.handleKeydown);
    if (!this.hasAttribute('tabindex')) {
      this.tabIndex = 0;
    }
    this.applyAspectRatio();
  }

  protected async firstUpdated() {
    this.stageObserver = new ResizeObserver(() => this.applyStageScale());
    if (this.src) {
      await this.loadStory(this.src);
    }
    this.observeStage();
  }

  protected updated() {
    const mode = this.activeUiMode();
    if (this.getAttribute('ui-mode') !== mode) {
      this.setAttribute('ui-mode', mode);
    }
    this.applyStageScale();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.stopScrubTracking();
    document.removeEventListener('fullscreenchange', this.handleFullscreenChange);
    this.removeEventListener('pointermove', this.resetUIHideTimer);
    this.removeEventListener('pointerdown', this.resetUIHideTimer);
    this.removeEventListener('keydown', this.handleKeydown);
    if (this.hideUIHandle) window.clearTimeout(this.hideUIHandle);
    if (this.urlSyncHandle) window.clearTimeout(this.urlSyncHandle);
    if (this.toolReadyTimer) window.clearTimeout(this.toolReadyTimer);
    this.stageObserver?.disconnect();
    this.audioEngine.dispose();
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
      // Attempt mobile landscape lock (not in the standard ScreenOrientation typings)
      const orientation = screen.orientation as ScreenOrientation & {
        lock?: (type: string) => Promise<void>;
      };
      if (orientation.lock) {
        orientation.lock('landscape').catch(() => { /* ignore if not supported or not allowed */ });
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

  private activeUiMode() {
    const scene = this.story?.scenes.find((item) => item.id === this.activeToolId);
    return resolveUiMode(this.story, scene, this.uiMode);
  }

  private resetUIHideTimer = () => {
    const keepChrome = this.activeUiMode() === 'inset' || !this.isPlaying || this.settingsOpen || this.chaptersOpen || this.ended || !this.sceneReady;
    this.isUIHidden = false;
    if (this.hideUIHandle) window.clearTimeout(this.hideUIHandle);
    if (keepChrome) {
      return;
    }
    const delay = window.matchMedia('(hover: none)').matches ? 4000 : 2500;
    this.hideUIHandle = window.setTimeout(() => {
      this.isUIHidden = true;
    }, delay);
  }

  private handlePlayCatcher = (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
    if (this.isUIHidden) {
      this.resetUIHideTimer();
      return;
    }
    this.isUIHidden = true;
    if (this.hideUIHandle) window.clearTimeout(this.hideUIHandle);
  }

  private observeStage() {
    if (!this.stageObserver) {
      return;
    }
    this.stageObserver.disconnect();
    const cell = this.videoSection || this.ratioWrapper;
    if (cell) {
      this.stageObserver.observe(cell);
      this.applyStageScale();
    }
  }

  private applyStageScale() {
    const wrap = this.ratioWrapper;
    const cell = this.videoSection || wrap;
    if (!wrap || !cell) {
      return;
    }
    const aspect = parseAspectRatio(this.story?.aspectRatio);
    const fitted = containSize(cell.clientWidth, cell.clientHeight, aspect);
    if (!(fitted.width > 0) || !(fitted.height > 0)) {
      return;
    }
    const stage = stageSize(aspect);
    wrap.style.width = `${fitted.width}px`;
    wrap.style.height = `${fitted.height}px`;
    wrap.style.setProperty('--stage-w', `${stage.width}px`);
    wrap.style.setProperty('--stage-h', `${stage.height}px`);
    wrap.style.setProperty('--stage-scale', String(fitted.width / stage.width));
  }

  private async loadStory(url: string) {
    try {
      this.storyBaseUrl = new URL(url, window.location.href).href;
      this.packSession = null;
      const urlState = readDiveUrlState();

      if (looksLikeDiveUrl(url)) {
        this.sceneReady = false;
        const session = await openDivePack(this.storyBaseUrl, { sceneId: urlState.sceneId });
        this.packSession = session;
        session.refreshStory();
        this.story = session.story;
      } else {
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`Failed to load DIVE source: ${response.status}`);
        }
        const buffer = new Uint8Array(await response.arrayBuffer());
        if (shouldLoadAsDive(url, buffer)) {
          const pack = await loadDivePack(buffer);
          this.story = pack.story;
        } else {
          this.story = JSON.parse(new TextDecoder().decode(buffer));
        }
      }

      this.applyAspectRatio(this.story?.aspectRatio);
      this.observeStage();
      this.playerLang = resolvePlayerLanguage(this.story?.languages, urlState.lang);
      this.allAudioSpecs = this.story ? collectStoryAudio(this.story, this.storyBaseUrl) : [];
      this.applyLocaleMedia();
      this.captionTracks = this.story
        ? await resolveCaptionTracks(this.story.captions, this.storyBaseUrl)
        : [];
      this.captionsEnabled = this.captionTracks.some((track) => track.kind !== 'descriptions');
      this.sceneReady = false;
      this.hasStarted = false;
      this.ended = false;
      await this.updateComplete;
      this.observeStage();
      
      this.sequencer = new Sequencer(this.story!, (state) => {
        this.currentTime = state.time;
        this.activeNarrativeState = state;
        if (this.story && state.time >= this.story.duration && state.time > 0) {
          if (this.isPlaying) {
            this.isPlaying = false;
          }
          this.ended = true;
        }
        this.syncMedia(state.time);
        this.scheduleUrlSync();

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
      const startScene = urlState.sceneId
        ? this.story?.scenes.find((scene) => scene.id === urlState.sceneId)
        : undefined;
      const startTime = urlState.timeMs ?? startScene?.startTime ?? 0;
      this.sequencer.seek(startTime);
      this.notifyAdapterPlaybackState();
      
    } catch (e) {
      console.error("Failed to load DIVE story:", e);
    }
  }

  private async ensureScenePacked(scene: Story['scenes'][0]): Promise<Story['scenes'][0]> {
    if (!this.packSession) {
      return scene;
    }
    const needed = filesForScene(this.packSession.manifest, scene.id);
    if (needed.length && !this.packSession.hasAll(needed)) {
      const resume = this.isPlaying;
      this.sceneReady = false;
      if (resume) {
        this.sequencer?.pause();
        this.isPlaying = false;
        this.playWhenReady = true;
      }
      try {
        await this.packSession.prioritizeScene(scene.id);
        await this.packSession.waitFor(needed);
      } finally {
        if (resume) {
          this.playWhenReady = true;
        }
      }
    }
    this.packSession.refreshStory();
    this.story = this.packSession.story;
    return this.story?.scenes.find((item) => item.id === scene.id) || scene;
  }

  private packedNameForUrl(url: string): string | null {
    if (!this.packSession) {
      return null;
    }
    for (const [name, mapped] of this.packSession.urls) {
      if (mapped === url) {
        return name;
      }
    }
    return null;
  }

  private async switchTool(scene: Story['scenes'][0]) {
    scene = await this.ensureScenePacked(scene);
    // Unmount previous
    if (this.activeAdapter) {
      this.activeAdapter.unmount();
      this.activeAdapter = null;
    }
    this.activeToolId = scene.id;
    this.activeScenePauseOnInteract = this.resolvePauseOnInteract(scene, null);
    this.toolFading = true;

    const tool = scene.tool;
    const packedName = this.packedNameForUrl(tool);

    // Load new adapter
    if (toolRegistry[tool]) {
      const AdapterClass = toolRegistry[tool];
      this.activeAdapter = new AdapterClass();
    } else if (tool.endsWith('.js') || packedName?.endsWith('.js')) {
      try {
        const moduleUrl = tool.startsWith('blob:') ? tool : new URL(tool, window.location.origin).href;
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
    } else if (
      tool.endsWith('.html')
      || packedName?.endsWith('.html')
      || packedName?.endsWith('.htm')
      || tool.startsWith('http://')
      || tool.startsWith('https://')
      || tool.startsWith('blob:')
    ) {
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
      const dataRef = scene.data;
      const shouldSendData = scene.sendData !== false && typeof dataRef !== 'undefined';

      if (shouldSendData && typeof dataRef === 'string') {
        const dataUrl = /^(https?:|blob:)/i.test(dataRef)
          ? dataRef
          : new URL(dataRef, this.storyBaseUrl || window.location.href).href;
        const res = await fetch(dataUrl);
        data = await res.json();
      } else if (shouldSendData) {
        data = dataRef;
      }

      this.armToolReady(scene);
      this.activeAdapter?.mount(this.canvasContainer, data);
      this.activeAdapter?.setLanguage?.(this.playerLang);
      this.activeAdapter?.onLanguage?.((code) => this.setLanguage(code));
      this.activeAdapter?.onReady?.(() => this.markToolReady());
      this.notifyAdapterPlaybackState();
      requestAnimationFrame(() => { this.toolFading = false; });
      this.prefetchNextScene(scene);
    } catch (e) {
      console.error("Failed to load data for tool:", e);
      this.markToolReady();
    }
  }

  private armToolReady(scene: Story['scenes'][0]) {
    if (this.toolReadyTimer) window.clearTimeout(this.toolReadyTimer);
    this.sceneReady = false;
    this.resetUIHideTimer();
    const needsReady = Boolean(this.activeAdapter?.onReady) || scene.tool.endsWith('.html') || scene.tool.startsWith('blob:');
    if (!needsReady) {
      this.markToolReady();
      return;
    }
    this.toolReadyTimer = window.setTimeout(() => this.markToolReady(), 8000);
  }

  private markToolReady() {
    if (this.toolReadyTimer) {
      window.clearTimeout(this.toolReadyTimer);
      this.toolReadyTimer = 0;
    }
    if (this.sceneReady) {
      return;
    }
    this.sceneReady = true;
    this.resetUIHideTimer();
    if (this.playWhenReady) {
      this.playWhenReady = false;
      this.beginPlayback();
    }
  }

  private beginPlayback() {
    if (!this.sequencer) return;
    if (!this.sceneReady) {
      this.playWhenReady = true;
      return;
    }
    this.audioEngine.unlock();
    this.audioEngine.markEvent('play');
    this.lastVisualState = null;
    this.hasStarted = true;
    this.ended = false;
    this.settingsOpen = false;
    this.chaptersOpen = false;
    if (this.currentTime >= (this.story?.duration || 0)) {
      this.audioHardSeek = true;
      this.sequencer.seek(0);
    }
    this.audioHardSeek = true;
    this.sequencer.hold(this.audioEngine.hasAudio);
    this.sequencer.play();
    this.isPlaying = true;
    this.notifyAdapterPlaybackState();
    this.resetUIHideTimer();
  }

  private notifyAdapterPlaybackState() {
    if (this.activeAdapter?.setPlaybackState) {
      this.activeAdapter.setPlaybackState(this.isPlaying, this.currentTime);
    }
    this.syncMedia(this.currentTime);
  }

  private applyAspectRatio(value?: string) {
    const aspect = parseAspectRatio(value);
    this.style.setProperty('--aspect-ratio', aspectCss(aspect));
    this.style.setProperty('--ar-w', String(aspect.width));
    this.style.setProperty('--ar-h', String(aspect.height));
  }

  private syncMedia(timeMs: number) {
    const hard = this.audioHardSeek;
    this.audioHardSeek = false;
    this.audioEngine.sync(timeMs, this.isPlaying, { hard });
    this.sequencer?.hold(this.isPlaying && this.audioEngine.isHoldingStory);
    if (this.audioDebugEnabled) {
      this.audioDebug = this.audioEngine.getDebug();
    }
    const tracks = captionTracksForLocale(this.captionTracks, this.playerLang, {
      captions: this.captionsEnabled,
      descriptions: this.descriptionsEnabled,
    });
    this.activeCues = tracks.flatMap((track) => cuesAtTime(track.cues, timeMs));
  }

  private formatAudioDebug(debug: AudioSyncDebug): string {
    const sign = debug.driftMs >= 0 ? '+' : '';
    return [
      `audio ${debug.mode}`,
      `target ${debug.targetSeconds.toFixed(3)}s`,
      `play   ${debug.audioSeconds.toFixed(3)}s`,
      `drift  ${sign}${debug.driftMs.toFixed(0)} ms`,
      `rate   100%`,
      this.audioEngine.isHoldingStory ? 'story  held for audio' : '',
      `log    ${this.audioEngine.getLogLength()} samples`,
      debug.holdMs > 0 ? `hold   ${debug.holdMs.toFixed(0)} ms` : '',
      debug.seeking ? 'decoder seeking' : '',
    ].filter(Boolean).join('\n');
  }

  private downloadAudioLog = () => {
    const blob = new Blob([this.audioEngine.exportLog()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `dive-audio-sync-${Date.now()}.json`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  private toggleMute() {
    this.isMuted = !this.isMuted;
    this.audioEngine.setMuted(this.isMuted);
  }

  private toggleCaptions() {
    this.captionsEnabled = !this.captionsEnabled;
    this.syncMedia(this.currentTime);
  }

  private togglePlay() {
    if (!this.sequencer) return;
    
    if (this.isPlaying || this.playWhenReady) {
      this.playWhenReady = false;
      this.audioEngine.markEvent('pause');
      this.sequencer.pause();
      this.isPlaying = false;
      this.notifyAdapterPlaybackState();
      this.resetUIHideTimer();
    } else {
      this.beginPlayback();
    }
  }

  private seekFromScrubberClientX(clientX: number, scrubber: HTMLElement) {
    if (!this.sequencer || !this.story) return;

    const rect = scrubber.getBoundingClientRect();
    const percent = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const timeMs = percent * this.story.duration;

    this.lastVisualState = null; // Force snapback on scrub
    this.ended = false;
    this.audioHardSeek = true;
    this.audioEngine.markEvent(`scrub:${Math.round(this.currentTime)}->${Math.round(timeMs)}`);
    this.sequencer.seek(timeMs);
  }

  private handleScrubPointerDown(e: PointerEvent) {
    if (!(e.currentTarget instanceof HTMLElement)) {
      return;
    }

    this.isScrubbing = true;
    this.scrubberElement = e.currentTarget;
    this.audioEngine.markEvent('scrub-start');
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
    this.audioEngine.markEvent('scrub-end');
    this.syncMedia(this.currentTime);
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

  private languageOptions(): LanguageOption[] {
    return listedLanguages(this.story?.languages);
  }

  private showLanguagePicker(): boolean {
    return (this.story?.languages?.length || 0) > 1;
  }

  private applyLocaleMedia() {
    this.audioEngine.configure(filterAudioClips(this.allAudioSpecs, this.playerLang, {
      descriptions: this.descriptionsEnabled,
    }));
    this.audioEngine.setMuted(this.isMuted);
    this.syncMedia(this.currentTime);
  }

  private setLanguage(code: string) {
    if (!this.story || this.playerLang === code) {
      return;
    }
    if (!this.languageOptions().some((item) => item.code === code)) {
      return;
    }
    this.playerLang = code;
    storeLanguage(code);
    this.applyLocaleMedia();
    this.activeAdapter?.setLanguage?.(code);
    this.scheduleUrlSync();
  }

  private toggleSettings = () => {
    this.settingsOpen = !this.settingsOpen;
    if (this.settingsOpen) {
      this.chaptersOpen = false;
    }
  };

  private toggleChapters = () => {
    this.chaptersOpen = !this.chaptersOpen;
    if (this.chaptersOpen) {
      this.settingsOpen = false;
    }
  };

  private jumpToScene(sceneId: string) {
    const scene = this.story?.scenes.find((item) => item.id === sceneId);
    if (!scene || !this.sequencer) {
      return;
    }
    this.chaptersOpen = false;
    this.ended = false;
    this.lastVisualState = null;
    this.audioHardSeek = true;
    this.audioEngine.markEvent(`chapter:${scene.id}`);
    this.sequencer.seek(scene.startTime);
  }

  private replay = () => {
    if (!this.sequencer) {
      return;
    }
    this.ended = false;
    this.hasStarted = true;
    this.lastVisualState = null;
    this.audioHardSeek = true;
    this.audioEngine.markEvent('replay');
    this.sequencer.seek(0);
    this.audioEngine.unlock();
    this.sequencer.play();
    this.isPlaying = true;
    this.notifyAdapterPlaybackState();
  };

  private scheduleUrlSync() {
    if (this.urlSyncHandle) {
      window.clearTimeout(this.urlSyncHandle);
    }
    this.urlSyncHandle = window.setTimeout(() => {
      writeDiveUrlState({
        timeMs: this.currentTime,
        sceneId: this.activeToolId || undefined,
        lang: this.playerLang,
      });
    }, 250);
  }

  private prefetchNextScene(scene: Story['scenes'][0]) {
    const index = this.story?.scenes.findIndex((item) => item.id === scene.id) ?? -1;
    const next = index >= 0 ? this.story?.scenes[index + 1] : undefined;
    if (!next) {
      return;
    }
    if (this.packSession) {
      void this.packSession.prioritizeScene(next.id);
      return;
    }
    const tool = next.tool;
    if (tool.endsWith('.html') || tool.endsWith('.js') || tool.startsWith('http')) {
      const href = new URL(tool, this.storyBaseUrl || window.location.href).href;
      const link = document.createElement('link');
      link.rel = 'prefetch';
      link.href = href;
      document.head.appendChild(link);
    }
  }

  private handleKeydown = (event: KeyboardEvent) => {
    if (event.altKey || event.ctrlKey || event.metaKey) {
      return;
    }
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')) {
      return;
    }
    switch (event.key) {
      case ' ':
      case 'k':
      case 'K':
        event.preventDefault();
        this.togglePlay();
        break;
      case 'ArrowLeft':
      case 'j':
      case 'J':
        event.preventDefault();
        this.nudge(-5000);
        break;
      case 'ArrowRight':
      case 'l':
      case 'L':
        event.preventDefault();
        this.nudge(5000);
        break;
      case 'Home':
        event.preventDefault();
        this.sequencer?.seek(0);
        break;
      case 'End':
        event.preventDefault();
        if (this.story) {
          this.sequencer?.seek(this.story.duration);
        }
        break;
      case 'f':
      case 'F':
        event.preventDefault();
        this.toggleFullscreen();
        break;
      case 'm':
      case 'M':
        event.preventDefault();
        this.toggleMute();
        break;
      case 'c':
      case 'C':
        event.preventDefault();
        this.toggleCaptions();
        break;
      case 'Escape':
        this.settingsOpen = false;
        this.chaptersOpen = false;
        break;
      default:
        break;
    }
  };

  private nudge(deltaMs: number) {
    if (!this.sequencer || !this.story) {
      return;
    }
    this.lastVisualState = null;
    this.ended = false;
    this.audioHardSeek = true;
    this.audioEngine.markEvent(`skip:${deltaMs}`);
    this.sequencer.seek(this.currentTime + deltaMs);
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
      if (overlay.type === 'audio') {
        return false;
      }
      if (!this.isPlaying && overlay.hideWhenPaused) {
        return false;
      }
      return true;
    });

    const aspect = parseAspectRatio(this.story.aspectRatio);
    const hasCaptions = this.captionTracks.some((track) => track.kind !== 'descriptions');
    const hasDescriptions = this.allAudioSpecs.some((clip) => clip.role === 'descriptions')
      || this.captionTracks.some((track) => track.kind === 'descriptions');
    const hasAudio = this.audioEngine.hasAudio || this.allAudioSpecs.length > 0;
    const languages = this.languageOptions();
    const showLang = this.showLanguagePicker();
    const poster = this.story.poster && !this.hasStarted ? this.story.poster : null;
    const title = resolveLocalized(this.story.title, this.playerLang);
    const hasSettings = true;
    const chromeMode = this.activeUiMode();
    const chromeHidden = chromeMode === 'autohide' && this.isUIHidden;

    return html`
      <div class="video-section">
        <div
          class="video-ratio-wrapper"
          style="--aspect-ratio: ${aspectCss(aspect)}; --ar-w: ${aspect.width}; --ar-h: ${aspect.height};"
        >
          <div id="canvas-container" class="${this.toolFading ? 'fading' : ''}" part="canvas"></div>
          ${chromeMode === 'autohide' && this.isPlaying ? html`<div class="play-catcher" @pointerdown=${this.handlePlayCatcher}></div>` : ''}
          ${poster ? html`<img class="poster" part="poster" src="${poster}" alt="" />` : ''}
          ${this.sceneReady ? '' : html`<div class="buffer-spinner" part="buffer" aria-label="Loading scene"></div>`}
          
          <!-- Overlay Layer -->
          <div class="overlays" part="overlays">
            ${visibleOverlays.map(o => html`
              <div class="overlay-item" part="overlay" style=${this.getOverlayPlacementStyle(o)}>
                ${o.type === 'image'
                  ? html`<img src="${resolveLocalized(o.content, this.playerLang)}" width="100%" />`
                  : html`<p>${resolveLocalized(o.content, this.playerLang)}</p>`}
              </div>
            `)}
          </div>

          ${this.audioDebugEnabled && this.audioDebug ? html`
            <div class="audio-debug" part="audio-debug">${this.formatAudioDebug(this.audioDebug)}</div>
          ` : ''}

          ${this.captionsEnabled && this.activeCues.length ? html`
            <div class="captions" part="captions" aria-hidden="true">
              ${this.activeCues.map((cue) => html`<div class="caption-cue">${cue.text}</div>`)}
            </div>
          ` : ''}

          ${this.ended ? html`
            <div class="end-screen" part="end-screen">
              <h2>${title || 'End'}</h2>
              <button @click=${this.replay}>Replay</button>
            </div>
          ` : ''}
        </div>
      </div>

      <!-- Controls Layer -->
      <div class="chrome-top">
      <button
        class="icon-btn corner-btn chapters ${chromeHidden ? 'hidden' : ''}"
        @click=${this.toggleChapters}
        title="Chapters"
        aria-label="Chapters"
        aria-pressed=${this.chaptersOpen}
      >
        <svg viewBox="0 0 24 24"><path d="M3 5h18v2H3V5zm0 6h18v2H3v-2zm0 6h18v2H3v-2z"/></svg>
      </button>

      ${hasSettings ? html`
        <button
          class="icon-btn corner-btn settings ${chromeHidden ? 'hidden' : ''}"
          @click=${this.toggleSettings}
          title="Settings"
          aria-label="Settings"
          aria-pressed=${this.settingsOpen}
        >
          <svg viewBox="0 0 24 24"><path d="M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.06-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96a7.2 7.2 0 0 0-1.63-.94l-.36-2.54A.49.49 0 0 0 13.9 2h-3.8a.49.49 0 0 0-.48.41l-.36 2.54c-.59.24-1.13.55-1.63.94l-2.39-.96a.49.49 0 0 0-.59.22L2.73 8.47a.49.49 0 0 0 .12.61l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.13.23.4.32.64.22l2.39-.96c.5.39 1.04.7 1.63.94l.36 2.54c.05.24.25.41.48.41h3.8c.23 0 .43-.17.48-.41l.36-2.54c.59-.24 1.13-.55 1.63-.94l2.39.96c.23.09.51 0 .64-.22l1.92-3.32a.49.49 0 0 0-.12-.61l-2.03-1.58zM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2z"/></svg>
        </button>
      ` : ''}
      </div>

      <div class="controls ${chromeHidden ? 'hidden' : ''}" part="controls">
        <button
          class="icon-btn"
          @click=${this.togglePlay}
          title="${this.isPlaying ? 'Pause' : 'Play'}"
          aria-label="${this.isPlaying ? 'Pause' : 'Play'}"
        >
          ${this.isPlaying
            ? html`<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#fff" d="M6 5h4v14H6V5zm8 0h4v14h-4V5z"/></svg>`
            : html`<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#fff" d="M8 5v14l11-7z"/></svg>`}
        </button>
        
        <div class="scrubber" part="scrubber" @pointerdown=${this.handleScrubPointerDown}>
          ${timelineSections.map((section, index) => {
            const startPercent = (section.startTime / duration) * 100;
            const widthPercent = ((section.endTime - section.startTime) / duration) * 100;
            const color = section.color || timelineSectionPalette[index % timelineSectionPalette.length];
            const tooltip = section.description
              ? `${resolveLocalized(section.label, this.playerLang)}: ${resolveLocalized(section.description, this.playerLang)}`
              : resolveLocalized(section.label, this.playerLang);
            const showLabel = widthPercent >= 8;

            return html`
              <div
                class="section-band"
                style="left: ${startPercent}%; width: ${widthPercent}%; background: ${color};"
                title="${tooltip}"
              >
                ${showLabel ? html`<span class="section-label">${resolveLocalized(section.label, this.playerLang)}</span>` : ''}
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

        ${hasAudio ? html`
          <button
            class="icon-btn"
            @click=${this.toggleMute}
            title="${this.isMuted ? 'Unmute' : 'Mute'}"
            aria-label="${this.isMuted ? 'Unmute' : 'Mute'}"
            aria-pressed=${this.isMuted}
          >
            ${this.isMuted
              ? html`<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#fff" d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3 3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4 9.91 6.09 12 8.18V4z"/></svg>`
              : html`<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#fff" d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>`}
          </button>
        ` : ''}

        ${hasCaptions ? html`
          <button
            class="icon-btn"
            @click=${this.toggleCaptions}
            title="${this.captionsEnabled ? 'Hide captions' : 'Show captions'}"
            aria-label="${this.captionsEnabled ? 'Hide captions' : 'Show captions'}"
            aria-pressed=${this.captionsEnabled}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#fff" d="M19 4H5c-1.11 0-2 .9-2 2v12c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm-8 7H9.5v-.5h-2v3h2V13H11v1c0 .55-.45 1-1 1H7c-.55 0-1-.45-1-1v-4c0-.55.45-1 1-1h3c.55 0 1 .45 1 1v1zm7 0h-1.5v-.5h-2v3h2V13H18v1c0 .55-.45 1-1 1h-3c-.55 0-1-.45-1-1v-4c0-.55.45-1 1-1h3c.55 0 1 .45 1 1v1z"/></svg>
          </button>
        ` : ''}

        <button class="icon-btn" @click=${this.toggleFullscreen} title="Toggle Fullscreen" aria-label="Toggle Fullscreen">
          ${this.isFullscreen
            ? html`<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#fff" d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"/></svg>`
            : html`<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#fff" d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>`}
        </button>
      </div>

      ${this.chaptersOpen ? html`
        <div class="drawer chapters" part="chapters">
          <h3>Chapters</h3>
          ${this.story.scenes.map((scene) => html`
            <button
              aria-current=${scene.id === this.activeToolId}
              @click=${() => this.jumpToScene(scene.id)}
            >${scene.id}</button>
          `)}
        </div>
      ` : ''}

      ${this.settingsOpen ? html`
        <div class="drawer settings" part="settings">
          <h3>Settings</h3>
          ${showLang ? html`
            <h3>Language</h3>
            ${languages.map((item) => html`
              <button
                aria-current=${item.code === this.playerLang}
                @click=${() => this.setLanguage(item.code)}
              >${item.label}</button>
            `)}
          ` : ''}
          ${hasCaptions ? html`
            <label>
              <input type="checkbox" .checked=${this.captionsEnabled} @change=${this.toggleCaptions} />
              Captions
            </label>
          ` : ''}
          ${hasDescriptions ? html`
            <label>
              <input
                type="checkbox"
                .checked=${this.descriptionsEnabled}
                @change=${() => { this.descriptionsEnabled = !this.descriptionsEnabled; this.applyLocaleMedia(); }}
              />
              Audio description
            </label>
          ` : ''}
          <label>
            <input
              type="checkbox"
              .checked=${this.audioDebugEnabled}
              @change=${() => {
                this.audioDebugEnabled = !this.audioDebugEnabled;
                this.audioDebug = this.audioDebugEnabled ? this.audioEngine.getDebug() : null;
              }}
            />
            Audio sync debug
          </label>
          <button type="button" @click=${this.downloadAudioLog}>
            Download sync log (${this.audioEngine.getLogLength()})
          </button>
        </div>
      ` : ''}
      
      <!-- Accessibility Layer: Parallel DOM (Hidden visually) -->
      <div aria-live="polite" class="sr-only" style="position: absolute; width: 1px; height: 1px; overflow: hidden;">
        ${[
          ...visibleOverlays.filter(o => o.type === 'text').map(o => resolveLocalized(o.content, this.playerLang)),
          ...this.activeCues.map((cue) => cue.text),
        ].join(' ')}
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
