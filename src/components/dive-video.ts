import { LitElement, html, css, type PropertyValues } from 'lit';
import { customElement, property, state, query } from 'lit/decorators.js';
import { Sequencer } from '../core/Sequencer';
import { Story, NarrativeState, TimelineSection, Overlay, OverlayAnchor, OverlayAnchorPlacement, OverlayCanonicalAnchor, OverlayPlacementUnit, CaptionCue, LanguageOption } from '../core/types';
import { IAdapter } from '../core/Adapter';
import { D3ScatterplotAdapter } from '../adapters/D3ScatterplotAdapter';
import { D3MapAdapter } from '../adapters/D3MapAdapter';
import { IframeAdapter } from '../adapters/IframeAdapter';

import { aspectCss, containSize, parseAspectRatio } from '../core/aspect';
import { stageSize } from '../core/stage';
import { AudioEngine, collectStoryAudio, filterAudioClips } from '../core/audio';
import { captionTracksForLocale, cuesAtTime, resolveCaptionTracks, ResolvedCaptionTrack } from '../core/captions';
import { filesForScene, loadDivePack, looksLikeDiveUrl, openDivePack, shouldLoadAsDive, DivePackSession } from '../core/dive-pack';
import { listedLanguages, playerCopy, resolveLocalized, resolvePlayerLanguage, storeLanguage } from '../core/locale';
import { readDiveUrlState, writeDiveUrlState } from '../core/url-state';
import { resolveUiMode } from '../core/ui-mode';
import { configurePlayer, onThemeChange, playerDefaults, PlayerDefaults, resolveLanguageToggle, resolvePauseOnInteract, themeCss } from '../core/config';

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

interface PreparedTool {
  container: HTMLElement;
  adapter: IAdapter | null;
  loading: Promise<void>;
  ready: boolean;
  error: Error | null;
  readyTimer: number;
  disposed: boolean;
}

@customElement('dive-video')
export class DiveVideo extends LitElement {
  /** Set site-wide defaults (theme, languages, toggle, pause, uiMode). Stories still override them. */
  static configure(defaults: PlayerDefaults) {
    configurePlayer(defaults);
  }

  @property({ type: String }) src = ''; // URL to the story JSON
  @property({ type: String, attribute: 'ui-mode' }) uiMode = '';
  @property({ type: String, attribute: 'language-toggle' }) languageToggle = '';

  @state() private story: Story | null = null;
  @state() private isPlaying = false;
  @state() private currentTime = 0;
  @state() private activeNarrativeState: NarrativeState | null = null;
  @state() private activeToolId: string | null = null;
  @state() private isFullscreen = false;
  @state() private isUIHidden = false;
  @property({ type: Boolean, attribute: 'muted', reflect: true }) isMuted = false;
  @state() private captionsEnabled = true;
  @state() private descriptionsEnabled = false;
  @state() private activeCues: CaptionCue[] = [];
  @state() private playerLang = 'en';
  @state() private settingsOpen = false;
  @state() private chaptersOpen = false;
  @state() private ended = false;
  @state() private hasStarted = false;
  @state() private sceneReady = true;
  @state() private sceneError = false;
  @state() private toolFading = false;
  private playWhenReady = false;
  private preparedTools = new Map<string, PreparedTool>();
  private toolSwitchVersion = 0;
  private audioHardSeek = false;

  @query('#canvas-container') private canvasContainer!: HTMLElement;
  @query('.video-ratio-wrapper') private ratioWrapper?: HTMLElement;
  @query('.video-section') private videoSection?: HTMLElement;

  private sequencer: Sequencer | null = null;
  private activeAdapter: IAdapter | null = null;
  private lastVisualState: any = null;
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
  private themeSheet: CSSStyleSheet | null = null;
  private stopThemeListener: (() => void) | null = null;

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
      font-family: var(--dive-font, sans-serif);
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
      background: var(--dive-chrome-bg, #111214);
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
      background: var(--dive-stage-bg, #f4f4f4);
      position: absolute;
      top: 0;
      left: 0;
      transform-origin: 0 0;
      transform: scale(var(--stage-scale, 1));
      transition: opacity 0.34s ease, transform 0.34s ease;
    }
    .play-catcher {
      position: absolute;
      inset: 0;
      z-index: 8;
      background: transparent;
    }
    #canvas-container.fading {
      opacity: 0;
      transform: scale(calc(var(--stage-scale, 1) * 0.985));
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
      color: var(--dive-chrome-fg, #fff);
      background: var(--dive-drawer-bg, rgba(10, 10, 12, 0.88));
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
      color: var(--dive-chrome-fg, #fff);
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
    .scene-error {
      position: absolute;
      inset: 0;
      display: grid;
      place-content: center;
      gap: 12px;
      text-align: center;
      color: #fff;
      background: rgba(0, 0, 0, 0.75);
      z-index: 9;
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
      color: var(--dive-chrome-fg, #fff);
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
      background: var(--dive-chrome-bg, #111214);
      z-index: 11;
    }
    .chrome-top-right {
      display: contents;
    }
    :host([ui-mode="inset"]) .chrome-top-right {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .lang-toggle {
      position: absolute;
      top: 10px;
      right: 54px;
      z-index: 11;
      display: flex;
      gap: 4px;
      padding: 4px;
      border-radius: 999px;
      background: rgba(0, 0, 0, 0.55);
      transition: opacity 0.25s ease;
    }
    .lang-toggle.solo {
      right: 10px;
    }
    .lang-toggle.hidden {
      opacity: 0;
      pointer-events: none;
    }
    :host([ui-mode="inset"]) .lang-toggle {
      position: relative;
      top: auto;
      right: auto;
      background: rgba(255, 255, 255, 0.08);
    }
    .lang-toggle button {
      border: none;
      cursor: pointer;
      margin: 0;
      padding: 8px 14px;
      font-size: 15px;
      font-weight: 700;
      letter-spacing: 0.03em;
      border-radius: 999px;
      background: transparent;
      color: color-mix(in srgb, var(--dive-chrome-fg, #fff) 70%, transparent);
    }
    .lang-toggle button[aria-current="true"] {
      background: var(--dive-accent, rgb(0, 123, 255));
      color: var(--dive-accent-contrast, #fff);
    }
    :host([ui-mode="inset"]) .controls {
      position: relative;
      bottom: auto;
      left: auto;
      right: auto;
      min-height: 56px;
      background: var(--dive-chrome-bg, #111214);
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
      color: var(--dive-chrome-fg, #fff);
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
    button.icon-btn svg,
    button.icon-btn svg path {
      fill: var(--dive-chrome-fg, #fff);
    }
    button.icon-btn svg {
      width: 24px;
      height: 24px;
      display: block;
      flex: none;
    }
    button.icon-btn.corner-btn {
      position: absolute;
      margin: 0;
      background: rgba(0, 0, 0, 0.55);
    }
    button {
      background: var(--dive-button-bg, #444);
      border: none;
      color: var(--dive-chrome-fg, #fff);
      padding: 8px 16px;
      cursor: pointer;
      border-radius: 4px;
      margin-right: 10px;
    }
    button:hover {
      background: var(--dive-button-hover-bg, #666);
    }
    .scrubber {
      flex-grow: 1;
      position: relative;
      height: 20px;
      background: var(--dive-scrubber-bg, #3f3f3f);
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
      background: var(--dive-progress, color-mix(in srgb, var(--dive-accent, rgb(0, 123, 255)) 55%, transparent));
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
    this.applyTheme();
    this.stopThemeListener = onThemeChange(() => this.applyTheme());
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

  protected updated(changedProperties: PropertyValues) {
    if (changedProperties.has('isMuted')) {
      this.audioEngine.setMuted(this.isMuted);
    }
    if (changedProperties.has('playerLang')) {
      this.dispatchEvent(new CustomEvent('dive-language-change', {
        detail: { lang: this.playerLang }, bubbles: true, composed: true,
      }));
    }
    const mode = this.activeUiMode();
    if (this.getAttribute('ui-mode') !== mode) {
      this.setAttribute('ui-mode', mode);
    }
    this.applyStageScale();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.stopThemeListener?.();
    this.stopThemeListener = null;
    this.stopScrubTracking();
    document.removeEventListener('fullscreenchange', this.handleFullscreenChange);
    this.removeEventListener('pointermove', this.resetUIHideTimer);
    this.removeEventListener('pointerdown', this.resetUIHideTimer);
    this.removeEventListener('keydown', this.handleKeydown);
    if (this.hideUIHandle) window.clearTimeout(this.hideUIHandle);
    if (this.urlSyncHandle) window.clearTimeout(this.urlSyncHandle);
    this.toolSwitchVersion++;
    this.sequencer?.pause();
    for (const tool of this.preparedTools.values()) this.disposePreparedTool(tool);
    this.preparedTools.clear();
    this.activeAdapter = null;
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

  private applyTheme() {
    const root = this.shadowRoot;
    if (!root || typeof CSSStyleSheet === 'undefined' || !('adoptedStyleSheets' in root)) {
      return;
    }
    if (!this.themeSheet) {
      this.themeSheet = new CSSStyleSheet();
      root.adoptedStyleSheets = [...root.adoptedStyleSheets, this.themeSheet];
    }
    this.themeSheet.replaceSync(themeCss());
  }

  private activeUiMode() {
    const scene = this.story?.scenes.find((item) => item.id === this.activeToolId);
    return resolveUiMode(this.story, scene, this.uiMode, playerDefaults().uiMode);
  }

  private pauseOnInteractActive() {
    const scene = this.story?.scenes.find((item) => item.id === this.activeToolId);
    return resolvePauseOnInteract(this.story, scene, this.activeNarrativeState?.visualState);
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
    if (this.activeUiMode() === 'autohide' && this.isUIHidden) {
      // First tap while chrome is hidden just reveals it again.
      this.resetUIHideTimer();
      return;
    }
    if (this.pauseOnInteractActive()) {
      // Interaction only ever pauses; resuming is the Play button's job.
      if (this.isPlaying) this.togglePlay();
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
      this.playerLang = resolvePlayerLanguage(this.storyLanguages(), urlState.lang);
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
      await this.packSession.prioritizeScene(scene.id);
      await this.packSession.waitFor(needed);
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
    const version = ++this.toolSwitchVersion;
    this.activeAdapter?.setPlaybackState?.(false, this.currentTime);
    this.activeAdapter = null;
    this.activeToolId = scene.id;
    this.sceneError = false;
    for (const prepared of this.preparedTools.values()) {
      this.setToolVisible(prepared, false);
    }

    const prepared = this.prepareTool(scene);
    this.sceneReady = prepared.ready;
    this.toolFading = !prepared.ready;
    this.syncMedia(this.currentTime);
    this.resetUIHideTimer();
    this.prefetchNextScene(scene);

    await prepared.loading;
    if (version !== this.toolSwitchVersion || prepared.disposed) return;
    if (prepared.error) {
      this.failTool(prepared.error);
      return;
    }
    this.activeAdapter = prepared.adapter;
    this.setToolVisible(prepared, true);
    this.activeAdapter?.setLanguage?.(this.playerLang);
    const state = this.activeNarrativeState?.visualState;
    if (state) this.activeAdapter?.setState(state, this.currentTime);
    this.lastVisualState = state;
    this.notifyAdapterPlaybackState();
    if (prepared.ready) this.markToolReady();
    requestAnimationFrame(() => {
      if (version === this.toolSwitchVersion) this.toolFading = false;
    });
  }

  private prepareTool(scene: Story['scenes'][0]): PreparedTool {
    const existing = this.preparedTools.get(scene.id);
    if (existing) return existing;
    const container = document.createElement('div');
    container.style.cssText = 'position:absolute;inset:0;visibility:hidden;pointer-events:none';
    container.inert = true;
    container.setAttribute('aria-hidden', 'true');
    this.canvasContainer.appendChild(container);
    const prepared: PreparedTool = {
      container, adapter: null, loading: Promise.resolve(), ready: false,
      error: null, readyTimer: 0, disposed: false,
    };
    this.preparedTools.set(scene.id, prepared);
    prepared.loading = this.loadPreparedTool(scene, prepared);
    return prepared;
  }

  private async loadPreparedTool(scene: Story['scenes'][0], prepared: PreparedTool): Promise<void> {
    try {
      scene = await this.ensureScenePacked(scene);
      if (prepared.disposed) return;
      const tool = scene.tool;
      const packedName = this.packedNameForUrl(tool);
      let adapter: IAdapter;
      if (toolRegistry[tool]) {
        adapter = new toolRegistry[tool]();
      } else if (tool.endsWith('.js') || packedName?.endsWith('.js')) {
        const moduleUrl = tool.startsWith('blob:') ? tool : new URL(tool, window.location.origin).href;
        const module = await import(/* @vite-ignore */ moduleUrl);
        const AdapterClass = module.default || Object.values(module)[0];
        if (typeof AdapterClass !== 'function') {
          throw new Error(`No valid adapter class found in module: ${tool}`);
        }
        adapter = new (AdapterClass as new () => IAdapter)();
      } else if (
        /\.html?$/.test(tool) || /\.html?$/.test(packedName || '')
        || /^(https?:|blob:)/.test(tool)
      ) {
        adapter = new IframeAdapter(/^(https?:|blob:)/.test(tool)
          ? tool : new URL(tool, this.storyBaseUrl || window.location.href).href);
      } else {
        throw new Error(`No adapter registered for tool: ${tool}`);
      }
      if (prepared.disposed) return;
      prepared.adapter = adapter;
      let data: unknown = undefined;
      const dataRef = scene.data;
      const shouldSendData = scene.sendData !== false && typeof dataRef !== 'undefined';

      if (shouldSendData && typeof dataRef === 'string') {
        const dataUrl = /^(https?:|blob:)/i.test(dataRef)
          ? dataRef
          : new URL(dataRef, this.storyBaseUrl || window.location.href).href;
        const res = await fetch(dataUrl);
        if (!res.ok) throw new Error(`Failed to load scene data: ${dataUrl} (${res.status})`);
        data = await res.json();
      } else if (shouldSendData) {
        data = dataRef;
      }

      if (prepared.disposed) return;
      const isActive = () => !prepared.disposed && this.activeToolId === scene.id;
      adapter.onInteract?.(() => {
        if (isActive() && this.isPlaying && this.pauseOnInteractActive()) this.togglePlay();
      });
      adapter.onLanguage?.((code) => {
        if (isActive()) this.setLanguage(code);
      });
      adapter.onNavigate?.((sceneId, play) => {
        if (isActive()) this.navigateToScene(sceneId, play);
      });
      const markReady = () => {
        if (prepared.disposed) return;
        prepared.ready = true;
        prepared.error = null;
        window.clearTimeout(prepared.readyTimer);
        if (isActive() && this.activeAdapter === adapter) this.markToolReady();
      };
      adapter.onReady?.(markReady);
      adapter.setLanguage?.(this.playerLang);
      adapter.setPlaybackState?.(false, scene.startTime);
      adapter.setPreloading?.(true);
      adapter.mount(prepared.container, data);
      adapter.setState(scene.keyframes[0]?.state || {}, scene.startTime);
      if (!adapter.onReady) prepared.ready = true;
      if (!prepared.ready) {
        prepared.readyTimer = window.setTimeout(() => {
          if (adapter.hasLoaded?.()) {
            console.warn(`Scene ${scene.id} loaded but did not signal DIVE_READY within 8 seconds; showing it anyway`);
            markReady();
            return;
          }
          prepared.error = new Error(`Scene ${scene.id} did not signal DIVE_READY within 8 seconds`);
          console.error('Failed to prepare DIVE scene:', prepared.error);
          if (isActive()) this.failTool(prepared.error);
        }, 8000);
      }
    } catch (error) {
      if (prepared.disposed) return;
      prepared.error = error instanceof Error ? error : new Error(String(error));
      console.error(`Failed to prepare DIVE scene ${scene.id}:`, error);
      if (this.activeToolId === scene.id) this.failTool(error);
    }
  }

  private setToolVisible(tool: PreparedTool, visible: boolean) {
    tool.adapter?.setPreloading?.(!visible);
    tool.container.style.visibility = visible ? 'visible' : 'hidden';
    tool.container.style.pointerEvents = visible ? 'auto' : 'none';
    tool.container.inert = !visible;
    tool.container.setAttribute('aria-hidden', String(!visible));
  }

  private disposePreparedTool(tool: PreparedTool) {
    tool.disposed = true;
    window.clearTimeout(tool.readyTimer);
    tool.adapter?.unmount();
    tool.container.remove();
  }

  private failTool(error: unknown) {
    console.error('DIVE scene is unavailable:', error);
    this.sceneError = true;
    this.sceneReady = false;
    this.toolFading = false;
    this.syncMedia(this.currentTime);
    this.resetUIHideTimer();
  }

  private retryTool = () => {
    const scene = this.story?.scenes.find((item) => item.id === this.activeToolId);
    if (!scene) return;
    const prepared = this.preparedTools.get(scene.id);
    if (prepared) this.disposePreparedTool(prepared);
    this.preparedTools.delete(scene.id);
    void this.switchTool(scene);
  }

  private markToolReady() {
    this.sceneError = false;
    this.sceneReady = true;
    this.resetUIHideTimer();
    if (this.playWhenReady) {
      this.playWhenReady = false;
      this.beginPlayback();
    } else {
      this.notifyAdapterPlaybackState();
    }
  }

  private beginPlayback() {
    if (!this.sequencer) return;
    if (!this.sceneReady) {
      this.playWhenReady = true;
      return;
    }
    this.audioEngine.unlock();
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
      this.activeAdapter.setPlaybackState(this.isPlaying && this.sceneReady, this.currentTime);
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
    this.audioEngine.sync(timeMs, this.isPlaying && this.sceneReady, { hard });
    this.sequencer?.hold(this.isPlaying && (!this.sceneReady || this.audioEngine.isHoldingStory));
    const tracks = captionTracksForLocale(this.captionTracks, this.playerLang, {
      captions: this.captionsEnabled,
      descriptions: this.descriptionsEnabled,
    });
    this.activeCues = tracks.flatMap((track) => cuesAtTime(track.cues, timeMs));
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

  private storyLanguages(): LanguageOption[] | undefined {
    return this.story?.languages?.length ? this.story.languages : playerDefaults().languages;
  }

  private languageOptions(): LanguageOption[] {
    return listedLanguages(this.storyLanguages());
  }

  private languagePlacement() {
    return resolveLanguageToggle(this.storyLanguages()?.length || 0, this.story, this.languageToggle);
  }

  private applyLocaleMedia() {
    this.audioEngine.configure(filterAudioClips(this.allAudioSpecs, this.playerLang, {
      descriptions: this.descriptionsEnabled,
    }));
    this.audioEngine.setMuted(this.isMuted);
    this.audioEngine.unlock();
    this.audioHardSeek = true;
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
    for (const tool of this.preparedTools.values()) {
      if (tool.adapter !== this.activeAdapter) tool.adapter?.setLanguage?.(code);
    }
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

  private navigateToScene(sceneId: string, play: boolean) {
    if (!this.story?.scenes.some((scene) => scene.id === sceneId) || !this.sequencer) return;
    if (this.isPlaying || this.playWhenReady) this.togglePlay();
    if (sceneId !== this.activeToolId) this.sceneReady = false;
    this.jumpToScene(sceneId);
    if (play) this.beginPlayback();
  }

  private jumpToScene(sceneId: string) {
    const scene = this.story?.scenes.find((item) => item.id === sceneId);
    if (!scene || !this.sequencer) {
      return;
    }
    this.chaptersOpen = false;
    this.ended = false;
    this.lastVisualState = null;
    this.audioHardSeek = true;
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
    for (const [id, tool] of this.preparedTools) {
      if (id !== scene.id && id !== next?.id) {
        this.disposePreparedTool(tool);
        this.preparedTools.delete(id);
      }
    }
    if (next) this.prepareTool(next);
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
    const ui = playerCopy(this.playerLang, playerDefaults().playerText, this.story?.playerText);
    if (!this.story) {
      return html`<div>${ui.loadingStory}</div>`;
    }

    const duration = this.story.duration;
    const percent = (this.currentTime / duration) * 100;
    const timelineSections = this.getTimelineSections();
    const activeScene = this.story.scenes.find((scene) => scene.id === this.activeToolId);
    const activeSceneData = activeScene?.data;
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
    const langPlacement = this.languagePlacement();
    const showLangMenu = langPlacement === 'menu';
    const poster = this.story.poster && !this.hasStarted ? this.story.poster : null;
    const title = resolveLocalized(this.story.title, this.playerLang);
    const hasSettings = showLangMenu || hasCaptions || hasDescriptions;
    const chromeMode = this.activeUiMode();
    const chromeHidden = chromeMode === 'autohide' && this.isUIHidden;
    const showCatcher = this.isPlaying && (chromeMode === 'autohide' || this.pauseOnInteractActive());

    return html`
      <div class="video-section">
        <div
          class="video-ratio-wrapper"
          style="--aspect-ratio: ${aspectCss(aspect)}; --ar-w: ${aspect.width}; --ar-h: ${aspect.height};"
        >
          <div id="canvas-container" class="${this.toolFading ? 'fading' : ''}" part="canvas"></div>
          ${showCatcher ? html`<div class="play-catcher" @pointerdown=${this.handlePlayCatcher}></div>` : ''}
          ${poster ? html`<img class="poster" part="poster" src="${poster}" alt="" />` : ''}
          ${this.sceneError
            ? html`<div class="scene-error" role="alert">${ui.sceneError}<button @click=${this.retryTool}>${ui.retry}</button></div>`
            : this.sceneReady ? '' : html`<div class="buffer-spinner" part="buffer" aria-label=${ui.loadingScene}></div>`}
          
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

          ${this.captionsEnabled && this.activeCues.length ? html`
            <div class="captions" part="captions" aria-hidden="true">
              ${this.activeCues.map((cue) => html`<div class="caption-cue">${cue.text}</div>`)}
            </div>
          ` : ''}

          ${this.ended ? html`
            <div class="end-screen" part="end-screen">
              <h2>${title || ui.end}</h2>
              <button @click=${this.replay}>${ui.replay}</button>
            </div>
          ` : ''}
        </div>
      </div>

      <!-- Controls Layer -->
      <div class="chrome-top">
      <button
        class="icon-btn corner-btn chapters ${chromeHidden ? 'hidden' : ''}"
        @click=${this.toggleChapters}
        title=${ui.chapters}
        aria-label=${ui.chapters}
        aria-pressed=${this.chaptersOpen}
      >
        <svg viewBox="0 0 24 24"><path d="M3 5h18v2H3V5zm0 6h18v2H3v-2zm0 6h18v2H3v-2z"/></svg>
      </button>

      <div class="chrome-top-right">
        ${langPlacement === 'inline' ? html`
          <div class="lang-toggle ${chromeHidden ? 'hidden' : ''} ${hasSettings ? '' : 'solo'}" part="lang-toggle" role="group" aria-label=${ui.language}>
            ${languages.map((item) => html`
              <button
                type="button"
                lang=${item.code}
                title=${item.label}
                aria-label="${item.label} (${item.code.toUpperCase()})"
                aria-current=${item.code === this.playerLang}
                @click=${() => this.setLanguage(item.code)}
              >${item.code.toUpperCase()}</button>
            `)}
          </div>
        ` : ''}

        ${hasSettings ? html`
          <button
            class="icon-btn corner-btn settings ${chromeHidden ? 'hidden' : ''}"
            @click=${this.toggleSettings}
            title=${ui.settings}
            aria-label=${ui.settings}
            aria-pressed=${this.settingsOpen}
          >
            <svg viewBox="0 0 24 24"><path d="M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.06-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96a7.2 7.2 0 0 0-1.63-.94l-.36-2.54A.49.49 0 0 0 13.9 2h-3.8a.49.49 0 0 0-.48.41l-.36 2.54c-.59.24-1.13.55-1.63.94l-2.39-.96a.49.49 0 0 0-.59.22L2.73 8.47a.49.49 0 0 0 .12.61l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.13.23.4.32.64.22l2.39-.96c.5.39 1.04.7 1.63.94l.36 2.54c.05.24.25.41.48.41h3.8c.23 0 .43-.17.48-.41l.36-2.54c.59-.24 1.13-.55 1.63-.94l2.39.96c.23.09.51 0 .64-.22l1.92-3.32a.49.49 0 0 0-.12-.61l-2.03-1.58zM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2z"/></svg>
          </button>
        ` : ''}
      </div>
      </div>

      <div class="controls ${chromeHidden ? 'hidden' : ''}" part="controls">
        <button
          class="icon-btn"
          @click=${this.togglePlay}
          title="${this.isPlaying ? ui.pause : ui.play}"
          aria-label="${this.isPlaying ? ui.pause : ui.play}"
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
            const label = timelineSections.find((section) => section.startTime === s.startTime)?.label || s.id;
            return html`<div class="scene-marker" style="left: ${pos}%" title="${resolveLocalized(label, this.playerLang)}"></div>`;
          })}
        </div>

        <div class="time-display">
          ${this.formatTime(this.currentTime)} / ${this.formatTime(duration)}
        </div>

        ${hasAudio ? html`
          <button
            class="icon-btn"
            @click=${this.toggleMute}
            title="${this.isMuted ? ui.unmute : ui.mute}"
            aria-label="${this.isMuted ? ui.unmute : ui.mute}"
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
            title="${this.captionsEnabled ? ui.hideCaptions : ui.showCaptions}"
            aria-label="${this.captionsEnabled ? ui.hideCaptions : ui.showCaptions}"
            aria-pressed=${this.captionsEnabled}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#fff" d="M19 4H5c-1.11 0-2 .9-2 2v12c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm-8 7H9.5v-.5h-2v3h2V13H11v1c0 .55-.45 1-1 1H7c-.55 0-1-.45-1-1v-4c0-.55.45-1 1-1h3c.55 0 1 .45 1 1v1zm7 0h-1.5v-.5h-2v3h2V13H18v1c0 .55-.45 1-1 1h-3c-.55 0-1-.45-1-1v-4c0-.55.45-1 1-1h3c.55 0 1 .45 1 1v1z"/></svg>
          </button>
        ` : ''}

        <button class="icon-btn" @click=${this.toggleFullscreen} title=${ui.fullscreen} aria-label=${ui.fullscreen}>
          ${this.isFullscreen
            ? html`<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#fff" d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"/></svg>`
            : html`<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#fff" d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>`}
        </button>
      </div>

      ${this.chaptersOpen ? html`
        <div class="drawer chapters" part="chapters">
          <h3>${ui.chapters}</h3>
          ${this.story.scenes.map((scene) => html`
            <button
              aria-current=${scene.id === this.activeToolId}
              @click=${() => this.jumpToScene(scene.id)}
            >${resolveLocalized(timelineSections.find((section) => section.startTime === scene.startTime)?.label || scene.id, this.playerLang)}</button>
          `)}
        </div>
      ` : ''}

      ${this.settingsOpen ? html`
        <div class="drawer settings" part="settings">
          <h3>${ui.settings}</h3>
          ${showLangMenu ? html`
            <h3>${ui.language}</h3>
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
              ${ui.captions}
            </label>
          ` : ''}
          ${hasDescriptions ? html`
            <label>
              <input
                type="checkbox"
                .checked=${this.descriptionsEnabled}
                @change=${() => { this.descriptionsEnabled = !this.descriptionsEnabled; this.applyLocaleMedia(); }}
              />
              ${ui.audioDescription}
            </label>
          ` : ''}
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
        <h3>${ui.data}</h3>
        ${!this.isPlaying ? html`
          <table>
            <caption>${ui.dataView}</caption>
            <tbody>
              ${Array.isArray(activeSceneData) 
                ? (activeSceneData as unknown as any[]).map((d: any) => html`
                <tr>${Object.entries(d).map(([k, v]) => html`<td>${k}: ${v}</td>`)}</tr>
              `) : html`<tr><td>${ui.dataLoading}</td></tr>`}
            </tbody>
          </table>
        ` : ''}
      </div>
    `;
  }
}
