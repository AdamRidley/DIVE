import { LitElement, html, svg, css, nothing, type PropertyValues } from 'lit';
import { customElement, property, state, query } from 'lit/decorators.js';
import { Sequencer } from '../core/Sequencer';
import { Story, NarrativeState, TimelineSection, Overlay, OverlayAnchor, OverlayAnchorPlacement, OverlayCanonicalAnchor, OverlayPlacementUnit, CaptionCue, LanguageOption } from '../core/types';
import { IAdapter } from '../core/Adapter';
import { D3ScatterplotAdapter } from '../adapters/D3ScatterplotAdapter';
import { D3MapAdapter } from '../adapters/D3MapAdapter';
import { IframeAdapter } from '../adapters/IframeAdapter';

import { DEFAULT_PRELOAD_ASPECT, aspectCss, containSize, parseAspectRatio, type AspectRatio } from '../core/aspect';
import { stageSize } from '../core/stage';
import { AudioEngine, collectStoryAudio, filterAudioClips } from '../core/audio';
import { captionTracksForLocale, cuesAtTime, resolveCaptionTracks, ResolvedCaptionTrack } from '../core/captions';
import { filesForScene, loadDivePack, looksLikeDiveUrl, openDivePack, shouldLoadAsDive, DivePackSession } from '../core/dive-pack';
import { listedLanguages, playerCopy, resolveLocalized, resolvePlayerLanguage, storeLanguage } from '../core/locale';
import { readDiveUrlState, writeDiveUrlState } from '../core/url-state';
import { parseUiMode, resolveUiMode } from '../core/ui-mode';
import { configurePlayer, onThemeChange, playerDefaults, PlayerDefaults, resolveLanguageToggle, resolvePauseOnInteract, themeCss } from '../core/config';

const toolRegistry: Record<string, new () => IAdapter> = {
  'map': D3MapAdapter,
  'scatterplot': D3ScatterplotAdapter,
};

export function registerTool(name: string, adapterClass: new () => IAdapter) {
  toolRegistry[name] = adapterClass;
}

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
  @property({ type: Boolean, attribute: 'captions-below' }) captionsBelow: boolean | undefined = undefined;
  /**
   * Aspect ratio to use before the story declares one, e.g. `16:9`. Falls back to
   * `--dive-preload-aspect-ratio`, then 16:9. Ignored once the story loads.
   */
  @property({ type: String, attribute: 'preload-aspect-ratio' }) preloadAspectRatio = '';

  @state() private story: Story | null = null;
  @state() private isPlaying = false;
  @state() private currentTime = 0;
  @state() private activeNarrativeState: NarrativeState | null = null;
  @state() private activeToolId: string | null = null;
  @state() private isFullscreen = false;
  @state() private isUIHidden = false;
  @property({ type: Boolean, attribute: 'muted' }) isMuted = false;
  @state() private volume = 1;
  private lastNonZeroVolume = 1;
  @state() private captionsEnabled = false;
  @state() private descriptionsEnabled = false;
  @state() private activeCues: CaptionCue[] = [];
  @state() private playerLang = 'en';
  private pendingLanguage: string | null = null;
  @state() private settingsOpen = false;
  @state() private chaptersOpen = false;
  @state() private languagesOpen = false;
  @state() private ended = false;
  @state() private hasStarted = false;
  @state() private sceneReady = true;
  @state() private sceneError = false;
  @state() private packMediaReady = true;
  @state() private packMediaError = false;
  private packedAudioKey = '';
  private packedAudioVersion = 0;
  private configuredAudioKey = '';
  @state() private storyError = false;
  private storyReadyEmitted = false;
  private warnedSettingsLinks = new Set<string>();
  @state() private toolFading = false;
  @state() private viewerUiMode: ReturnType<typeof parseUiMode> = null;
  @state() private viewerCaptionsBelow: boolean | null = null;
  @state() private timelineHover: { time: number; x: number } | null = null;
  private belowCaptionFitKey = '';
  private playWhenReady = false;
  private preparedTools = new Map<string, PreparedTool>();
  private toolSwitchVersion = 0;
  private audioHardSeek = false;

  @query('#canvas-container') private canvasContainer!: HTMLElement;
  @query('.video-ratio-wrapper') private ratioWrapper?: HTMLElement;
  @query('.video-section') private videoSection?: HTMLElement;
  @query('.picture-area') private pictureArea?: HTMLElement;

  private sequencer: Sequencer | null = null;
  private activeAdapter: IAdapter | null = null;
  private lastVisualState: any = null;
  private isScrubbing = false;
  private scrubberElement: HTMLElement | null = null;
  private hideUIHandle = 0;
  private keyboardNavigationActive = false;
  private audioEngine = new AudioEngine();
  private captionTracks: ResolvedCaptionTrack[] = [];
  private storyBaseUrl = '';
  private packSession: DivePackSession | null = null;
  private urlSyncHandle = 0;
  private allAudioSpecs: ReturnType<typeof collectStoryAudio> = [];
  private stageObserver: ResizeObserver | null = null;
  private observedStage: Element | null = null;
  private sizeObserver: ResizeObserver | null = null;
  private sizeTargets = new Set<Element>();
  private autoHeightFrame = 0;
  private themeSheet: CSSStyleSheet | null = null;
  private sizingSheet: CSSStyleSheet | null = null;
  private autoHeight = '';
  private hostInternals = this.attachInternals();
  private stopThemeListener: (() => void) | null = null;

  static styles = css`
    :host {
      display: block;
      position: relative;
      width: 100%;
      max-width: 100%;
      height: auto;
      aspect-ratio: var(--aspect-ratio, var(--dive-preload-aspect-ratio, 16 / 9));
      background: #000;
      overflow: hidden;
      font-family: var(--dive-font, sans-serif);
      outline: none;
      container: dive-player / inline-size;
    }
    :host(:focus-visible) {
      outline: 3px solid var(--dive-chrome-fg, #fff);
      outline-offset: -3px;
    }
    :host(:fullscreen) {
      width: 100%;
      height: 100%;
      aspect-ratio: auto;
    }
    :host(:state(inset)) {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: auto minmax(0, 1fr) auto;
      background: var(--dive-chrome-bg, #111214);
    }
    :host(:state(inset):fullscreen) {
      grid-template-rows: auto minmax(0, 1fr) auto;
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
    :host(:state(inset)) .video-section {
      grid-row: 2;
      position: relative;
      inset: auto;
      min-width: 0;
      min-height: 0;
      width: 100%;
      height: 100%;
    }
    :host(:state(captions-below)) .video-section {
      grid-template-rows: minmax(0, 1fr) auto;
    }
    .picture-area {
      display: grid;
      place-items: center;
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
      transition: opacity 0.34s ease;
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
      box-sizing: border-box;
      overflow-wrap: anywhere;
      max-width: min(280px, 80%);
      max-height: 55%;
      overflow: auto;
      border-radius: 8px;
      padding: 10px 0;
      box-shadow: 0 8px 24px rgba(0,0,0,0.4);
    }
    .drawer.settings {
      right: 10px;
      bottom: calc(100% + 8px);
      max-height: min(55dvh, 360px);
    }
    .drawer h3 {
      margin: 0 12px 8px;
      font-size: 11px;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      opacity: 0.7;
    }
    .drawer button,
    .drawer label,
    .drawer a {
      display: block;
      width: 100%;
      box-sizing: border-box;
      white-space: normal;
      text-align: left;
      background: transparent;
      border: 0;
      color: var(--dive-chrome-fg, #fff);
      padding: 8px 12px;
      margin: 0;
      border-radius: 0;
      font-size: 13px;
      font-family: inherit;
    }
    .drawer button:hover,
    .drawer label:hover,
    .drawer button[aria-current="true"],
    .drawer a:hover {
      background: rgba(255,255,255,0.12);
    }
    .drawer label {
      display: flex;
      align-items: center;
      gap: 8px;
      cursor: pointer;
    }
    .drawer a { text-decoration: underline; text-underline-offset: 3px; }
    .drawer label.setting-select {
      align-items: stretch;
      flex-direction: column;
    }
    .setting-select select {
      box-sizing: border-box;
      width: 100%;
      min-width: 0;
      min-height: 36px;
      padding: 6px 8px;
      border: 1px solid currentColor;
      border-radius: 4px;
      color: var(--dive-chrome-fg, #fff);
      background: var(--dive-drawer-bg, #111214);
      font: inherit;
    }
    .dropdown-anchor {
      position: absolute;
      top: 8px;
      z-index: 12;
      min-width: 0;
    }
    .chapter-menu-anchor { left: 8px; }
    .language-menu-anchor { right: 8px; }
    .dropdown-button {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      min-width: 40px;
      min-height: 40px;
      margin: 0;
      padding: 8px 10px;
      border: 1px solid transparent;
      border-radius: 6px;
      color: var(--dive-chrome-fg, #fff);
      background: transparent;
      font: inherit;
      font-size: 13px;
      font-weight: 600;
    }
    .dropdown-button:hover,
    .dropdown-button[aria-expanded="true"] {
      background: rgba(255, 255, 255, 0.12);
    }
    .dropdown-button.hidden { visibility: hidden; }
    .dropdown-button svg { width: 18px; height: 18px; flex: none; }
    .dropdown-label { display: var(--dive-header-label-display, none); }
    .dropdown-chevron { display: var(--dive-header-chevron-display, none); }
    .drawer.dropdown {
      top: calc(100% + 8px);
      width: min(240px, calc(100cqw - 24px));
      min-width: min(180px, calc(100cqw - 24px));
      max-width: calc(100cqw - 24px);
      max-height: min(55dvh, 360px);
      padding: 6px 0;
      border: 1px solid color-mix(in srgb, var(--dive-chrome-fg, #fff) 14%, transparent);
      background: color-mix(in srgb, var(--dive-drawer-bg, #111214) 88%, transparent);
      backdrop-filter: blur(14px);
      scrollbar-width: thin;
      scrollbar-color: color-mix(in srgb, var(--dive-chrome-fg, #fff) 30%, transparent) transparent;
    }
    .drawer.chapters { left: 0; }
    .drawer.languages { right: 0; }
    .drawer.dropdown button {
      border-left: 3px solid transparent;
      padding-left: 9px;
    }
    .drawer.dropdown button:hover {
      background: color-mix(in srgb, var(--dive-accent, #aaa) 12%, transparent);
    }
    .drawer.dropdown button[aria-current="true"] {
      border-left-color: var(--dive-accent, #aaa);
      background: color-mix(in srgb, var(--dive-accent, #aaa) 24%, transparent);
      font-weight: 600;
    }
    .dropdown-button:focus-visible,
    .drawer a:focus-visible,
    .drawer button:focus-visible {
      outline: 2px solid currentColor;
      outline-offset: -3px;
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
      bottom: var(--dive-caption-bottom, 2%);
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
    .captions.clear-controls { bottom: max(var(--dive-caption-bottom, 2%), 76px); }
    .captions.below {
      position: static;
      box-sizing: border-box;
      width: 100%;
      min-width: 0;
      max-width: 100%;
      height: calc(1lh + 16px);
      flex-shrink: 0;
      display: grid;
      place-items: center;
      padding: 8px 16px;
      background: var(--dive-chrome-bg, #111214);
      color: #fff;
      font-size: clamp(14px, 2.4cqw, 20px);
      line-height: 1.35;
    }
    .captions.below .caption-cue {
      display: block;
      box-sizing: border-box;
      background: none;
      padding: 0;
      font-size: inherit;
      line-height: inherit;
      white-space: nowrap;
      width: 100%;
      max-width: 100%;
      overflow: hidden;
      text-overflow: clip;
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
    .buffer-spinner.media-buffer {
      inset: 12px 12px auto auto;
      padding: 8px;
      border-radius: 50%;
      background: var(--dive-chrome-bg, #111214);
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
      background: linear-gradient(to top, rgba(0, 0, 0, 0.82), rgba(0, 0, 0, 0.5) 55%, transparent);
      display: flex;
      flex-wrap: nowrap;
      min-width: 0;
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
    .top-scrim {
      position: absolute;
      inset: 0 0 auto;
      height: 58px;
      background: var(--dive-top-scrim, linear-gradient(rgba(0, 0, 0, 0.82), rgba(0, 0, 0, 0.5) 55%, transparent));
      z-index: 10;
      pointer-events: none;
      transition: opacity 0.25s ease;
    }
    .top-scrim.hidden { opacity: 0; }
    :host(:state(inset)) .chrome-top {
      grid-row: 1;
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      background: var(--dive-chrome-bg, #111214);
      border-bottom: var(--dive-chrome-divider, 1px solid rgba(255, 255, 255, 0.14));
      z-index: 11;
    }
    :host(:state(inset)) .dropdown-anchor { position: relative; inset: auto; }
    :host(:state(inset)) .chapter-menu-anchor { justify-self: start; }
    .chrome-help {
      min-width: 0;
      text-align: center;
      overflow-wrap: anywhere;
      color: var(--dive-chrome-fg, #fff);
      font-size: 13px;
      line-height: 1.4;
    }
    .chrome-top-right {
      display: contents;
    }
    :host(:state(inset)) .chrome-top-right {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 8px;
    }
    .lang-toggle {
      position: absolute;
      top: 10px;
      right: 54px;
      z-index: 11;
      display: grid;
      grid-template-columns: repeat(var(--language-count), minmax(0, 1fr));
      isolation: isolate;
      padding: 4px;
      border-radius: 999px;
      background: rgba(0, 0, 0, 0.55);
      transition: opacity 0.25s ease;
      color: var(--dive-chrome-fg, #fff);
      user-select: none;
    }
    .lang-toggle::before {
      content: '';
      position: absolute;
      left: 4px;
      bottom: 5px;
      width: calc((100% - 8px) / var(--language-count));
      height: 2px;
      background: linear-gradient(to right, transparent 18%, var(--dive-accent, currentColor) 18% 82%, transparent 82%);
      transform: translateX(calc(var(--language-index) * 100%));
      transition: transform 240ms cubic-bezier(0.22, 1, 0.36, 1);
      pointer-events: none;
    }
    .lang-toggle.solo {
      right: 10px;
    }
    .lang-toggle.hidden {
      opacity: 0;
      pointer-events: none;
    }
    :host(:state(inset)) .lang-toggle {
      position: relative;
      top: auto;
      right: auto;
      background: rgba(255, 255, 255, 0.08);
    }
    .lang-toggle button {
      border: none;
      cursor: pointer;
      margin: 0;
      position: relative;
      min-width: 44px;
      min-height: 40px;
      padding: 8px 14px 10px;
      font-size: 15px;
      font-weight: 700;
      letter-spacing: 0.03em;
      border-radius: 999px;
      background: transparent;
      color: inherit;
      font-family: inherit;
      transition: background-color 160ms ease-out;
    }
    .lang-toggle button[aria-current="true"] {
      background: transparent;
      color: inherit;
    }
    .lang-toggle button:hover {
      background: rgba(255, 255, 255, 0.08);
    }
    .lang-toggle button:focus-visible {
      outline: 2px solid currentColor;
      outline-offset: -3px;
    }
    .language-name {
      display: var(--dive-language-name-display, none);
    }
    .language-code {
      display: var(--dive-language-code-display, inline);
    }
    :host(:state(inset)) .controls {
      grid-row: 3;
      position: relative;
      bottom: auto;
      left: auto;
      right: auto;
      min-height: 56px;
      background: var(--dive-chrome-bg, #111214);
      border-top: var(--dive-chrome-divider, 1px solid rgba(255, 255, 255, 0.14));
      transform: none;
      opacity: 1;
      pointer-events: auto;
    }
    :host(:state(inset)) .corner-btn,
    :host(:state(inset)) button.icon-btn.corner-btn {
      position: relative;
      top: auto;
      left: auto;
      right: auto;
      background: rgba(255, 255, 255, 0.08);
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
    button.icon-btn svg path.volume-stroke { fill: none; }
    button.play-btn {
      -webkit-user-select: none;
      user-select: none;
      order: var(--dive-play-button-order, 0);
      width: auto;
      min-width: var(--dive-play-button-min-width, 40px);
      height: var(--dive-play-button-height, 40px);
      padding: var(--dive-play-button-padding, 0);
      gap: var(--dive-play-button-gap, 0);
      border: var(--dive-play-button-border, 0);
      border-radius: var(--dive-play-button-radius, 8px);
      background: var(--dive-play-button-bg, transparent);
      backdrop-filter: var(--dive-play-button-backdrop-filter, none);
      font-size: var(--dive-play-button-font-size, inherit);
      font-weight: var(--dive-play-button-font-weight, normal);
      box-sizing: border-box;
    }
    button.play-btn:hover {
      background: var(--dive-play-button-hover-bg, rgba(255, 255, 255, 0.16));
      border-color: var(--dive-play-button-hover-border-color, currentColor);
    }
    button.play-btn svg {
      width: var(--dive-play-button-icon-size, 24px);
      height: var(--dive-play-button-icon-size, 24px);
    }
    .play-label {
      display: var(--dive-play-button-label-display, none);
    }
    .volume-control {
      position: relative;
      order: 1;
      flex: none;
    }
    .volume-popup {
      position: absolute;
      bottom: 100%;
      left: 50%;
      transform: translateX(-50%);
      padding: 12px;
      border: 1px solid color-mix(in srgb, var(--dive-chrome-fg, #fff) 18%, transparent);
      border-radius: 8px;
      background: var(--dive-drawer-bg, #111214);
      opacity: 0;
      pointer-events: none;
    }
    .volume-control:hover .volume-popup,
    .volume-control:focus-within .volume-popup {
      opacity: 1;
      pointer-events: auto;
    }
    .volume-slider {
      writing-mode: vertical-lr;
      direction: rtl;
      appearance: auto;
      width: 24px;
      height: 110px;
      margin: 0;
      accent-color: var(--dive-accent, #aaa);
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
    .scrubber:focus-visible { outline: 3px solid currentColor; outline-offset: 3px; }
    :host(:state(pointer-input)) .scrubber:focus-visible,
    :host(:state(pointer-input):focus-visible) { outline: none; }
    .scrubber {
      order: 3;
      -webkit-user-select: none;
      user-select: none;
      touch-action: none;
      flex-grow: 1;
      flex-basis: 0;
      min-width: 60px;
      position: relative;
      height: 20px;
      background: var(--dive-scrubber-bg, #3f3f3f);
      margin: 0 12px;
      cursor: pointer;
      border-radius: 10px;
      overflow: visible;
    }
    .timeline-sections {
      position: absolute;
      inset: 0;
      border-radius: inherit;
      overflow: hidden;
    }
    .section-band {
      position: absolute;
      top: 0;
      height: 100%;
      box-sizing: border-box;
      pointer-events: auto;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .section-band::before {
      content: '';
      position: absolute;
      left: 0;
      top: 0;
      width: var(--dive-timeline-boundary-width, 1px);
      height: 100%;
      background: var(--dive-timeline-boundary, #fff);
      transform: translateX(-50%);
      pointer-events: none;
      z-index: 2;
    }
    .section-band.first { border-radius: 10px 0 0 10px; }
    .section-band.last { border-radius: 0 10px 10px 0; }
    .section-label {
      position: relative;
      z-index: 3;
      font-size: 10px;
      color: #fff;
      background: rgba(0, 0, 0, 0.75);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 100%;
      padding: 0 6px;
      text-shadow: none;
      pointer-events: none;
    }
    .progress {
      position: absolute;
      inset: 0;
      border-radius: inherit;
      background: var(--dive-progress-fill, var(--dive-progress-color, var(--dive-progress, var(--dive-accent, #f05f5f))));
      clip-path: inset(0 calc(100% - var(--progress)) 0 0);
      pointer-events: none;
      z-index: 1;
    }
    .playhead {
      position: absolute;
      top: 0;
      width: 4px;
      height: 100%;
      background: var(--dive-playhead, #fff);
      box-shadow: 0 0 0 2px rgba(0, 0, 0, 0.65);
      pointer-events: none;
      z-index: 5;
    }
    .scene-marker {
      position: absolute;
      top: 50%;
      width: 4px;
      height: 4px;
      border-radius: 50%;
      transform: translate(-50%, -50%);
      background: var(--dive-scene-marker, rgba(255, 255, 255, 0.3));
      z-index: 2;
      pointer-events: auto;
    }
    .chapter-marker {
      width: 8px;
      height: 8px;
      box-sizing: border-box;
      border: 1px solid var(--dive-timeline-boundary, #fff);
      background: var(--dive-chapter-marker, #cbd3d4);
      z-index: 4;
    }
    .chapter-marker.active,
    .chapter-marker.visited {
      background: var(--dive-chapter-active-marker, var(--dive-accent, #aaa));
    }
    .chapter-marker.active { width: 10px; height: 10px; border-width: 2px; }
    .timeline-tooltip {
      position: absolute;
      bottom: calc(100% + 10px);
      z-index: 20;
      width: max-content;
      max-width: min(220px, calc(100cqw - 24px));
      padding: 7px 10px;
      box-sizing: border-box;
      border: 1px solid color-mix(in srgb, var(--dive-chrome-fg, #fff) 18%, transparent);
      border-bottom: 2px solid var(--dive-accent, #aaa);
      border-radius: 6px;
      color: var(--dive-chrome-fg, #fff);
      background: var(--dive-drawer-bg, #111214);
      font-size: 12px;
      line-height: 1.35;
      white-space: normal;
      overflow-wrap: anywhere;
      text-align: center;
      transform: translateX(-50%);
      pointer-events: none;
    }
    .timeline-tooltip-heading { display: block; font-weight: 700; }
    .timeline-tooltip-subheading { display: block; margin-top: 3px; }
    .time-display {
      -webkit-user-select: none;
      user-select: none;
      order: var(--dive-time-display-order, 2);
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
      white-space: nowrap;
      text-align: right;
      font-variant-numeric: tabular-nums;
    }
    .controls > button:not(.play-btn) { order: 4; }
    @container dive-player (max-width: 600px) {
      .dropdown-label { display: none; }
      .chrome-help { font-size: 12px; }
      :host(:state(inset)) .chrome-top { padding-inline: 8px; }
      .captions.clear-controls { bottom: max(var(--dive-caption-bottom, 2%), 120px); }
    }
    @container dive-player (max-width: 600px) {
      .controls {
        flex-wrap: wrap;
      }
      .scrubber {
        flex-basis: 100%;
        order: -1;
        margin: 0 0 8px;
      }
      .time-display {
        margin-right: auto;
      }
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    this.applyTheme();
    this.stopThemeListener = onThemeChange(() => this.applyTheme());
    document.addEventListener('fullscreenchange', this.handleFullscreenChange);
    document.addEventListener('pointerdown', this.handleDropdownOutsidePointerDown, true);
    this.addEventListener('pointermove', this.resetUIHideTimer);
    this.addEventListener('pointerdown', this.handlePointerInteraction, true);
    this.addEventListener('pointerenter', this.resetUIHideTimer);
    this.addEventListener('pointerleave', this.handlePointerLeave);
    this.addEventListener('keydown', this.handleKeydown);
    this.addEventListener('keydown', this.handleKeyboardNavigation, true);
    this.addEventListener('focusin', this.resetUIHideTimer);
    this.addEventListener('focusout', this.handleFocusOut);
    if (!this.hasAttribute('tabindex')) {
      this.tabIndex = 0;
    }
  }

  protected async firstUpdated() {
    this.stageObserver = new ResizeObserver(() => this.applyStageScale());
    this.sizeObserver = new ResizeObserver(() => {
      if (this.autoHeightFrame) return;
      this.autoHeightFrame = requestAnimationFrame(() => {
        this.autoHeightFrame = 0;
        this.fitBelowCaption();
        this.applyAutoHeight();
      });
    });
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
    this.setHostState('inset', this.activeUiMode() === 'inset');
    this.setHostState('captions-below', this.activeCaptionsBelow());
    this.observeStage();
    this.fitBelowCaption();
    this.observeSize();
    if (changedProperties.has('playerLang')) this.updateFrameTitles();
  }

  private updateFrameTitles() {
    for (const [sceneId, tool] of this.preparedTools) {
      const frame = tool.container.querySelector('iframe');
      if (!frame) continue;
      const scene = this.story?.scenes.find(item => item.id === sceneId);
      const label = scene?.label || this.story?.timelineSections?.find(section => section.startTime === scene?.startTime)?.label;
      frame.title = resolveLocalized(label || this.story?.title || sceneId, this.playerLang);
    }
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.stopThemeListener?.();
    this.stopThemeListener = null;
    this.stopScrubTracking();
    document.removeEventListener('fullscreenchange', this.handleFullscreenChange);
    document.removeEventListener('pointerdown', this.handleDropdownOutsidePointerDown, true);
    this.removeEventListener('pointermove', this.resetUIHideTimer);
    this.removeEventListener('pointerdown', this.handlePointerInteraction, true);
    this.removeEventListener('pointerenter', this.resetUIHideTimer);
    this.removeEventListener('pointerleave', this.handlePointerLeave);
    this.removeEventListener('keydown', this.handleKeydown);
    this.removeEventListener('keydown', this.handleKeyboardNavigation, true);
    this.removeEventListener('focusin', this.resetUIHideTimer);
    this.removeEventListener('focusout', this.handleFocusOut);
    if (this.hideUIHandle) window.clearTimeout(this.hideUIHandle);
    if (this.urlSyncHandle) window.clearTimeout(this.urlSyncHandle);
    this.toolSwitchVersion++;
    this.sequencer?.pause();
    for (const tool of this.preparedTools.values()) this.disposePreparedTool(tool);
    this.preparedTools.clear();
    this.activeAdapter = null;
    this.stageObserver?.disconnect();
    this.observedStage = null;
    this.sizeObserver?.disconnect();
    this.sizeTargets.clear();
    cancelAnimationFrame(this.autoHeightFrame);
    this.autoHeightFrame = 0;
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
    return this.viewerUiMode || resolveUiMode(this.story, scene, this.uiMode, playerDefaults().uiMode);
  }

  private activeCaptionsBelow() {
    return this.viewerCaptionsBelow ?? this.captionsBelow ?? this.story?.captionsBelow ?? false;
  }

  private pauseOnInteractActive() {
    const scene = this.story?.scenes.find((item) => item.id === this.activeToolId);
    return resolvePauseOnInteract(this.story, scene, this.activeNarrativeState?.visualState);
  }

  private canHideUI() {
    const keyboardFocus = this.keyboardNavigationActive
      && (this.matches(':focus-within') || this.matches(':focus'));
    const volumeInteraction = !!this.shadowRoot?.querySelector('.volume-control:hover, .volume-slider:active');
    return this.activeUiMode() === 'autohide' && this.isPlaying && !this.settingsOpen && !this.chaptersOpen && !this.languagesOpen && !this.isScrubbing && !this.ended && this.sceneReady && !keyboardFocus && !volumeInteraction;
  }

  private handlePointerLeave = (event: PointerEvent) => {
    if (event.pointerType === 'touch' || !this.canHideUI()) return;
    if (this.hideUIHandle) window.clearTimeout(this.hideUIHandle);
    this.isUIHidden = true;
  };

  private handlePointerInteraction = () => {
    this.setHostState('pointer-input', true);
    this.keyboardNavigationActive = false;
    if (this.activeUiMode() === 'autohide' && this.isUIHidden) return;
    this.resetUIHideTimer();
  };

  private handleKeyboardNavigation = (event: KeyboardEvent) => {
    this.setHostState('pointer-input', false);
    if (['Tab', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) {
      this.keyboardNavigationActive = true;
      this.resetUIHideTimer();
    }
  };

  private resetUIHideTimer = () => {
    this.isUIHidden = false;
    if (this.hideUIHandle) window.clearTimeout(this.hideUIHandle);
    this.hideUIHandle = 0;
    this.scheduleUIHideTimer();
  }

  private scheduleUIHideTimer() {
    if (this.isUIHidden || this.hideUIHandle || !this.canHideUI()) return;
    const delay = window.matchMedia('(hover: none)').matches ? 4000 : 2500;
    this.hideUIHandle = window.setTimeout(() => {
      this.hideUIHandle = 0;
      if (this.canHideUI()) this.isUIHidden = true;
    }, delay);
  }

  private handleFocusOut = () => {
    queueMicrotask(() => this.resetUIHideTimer());
  };

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
    const cell = this.pictureArea || this.videoSection || this.ratioWrapper;
    if (cell !== this.observedStage) {
      this.stageObserver.disconnect();
      this.observedStage = cell ?? null;
      if (cell) this.stageObserver.observe(cell);
    }
    if (cell) {
      this.applyStageScale();
    }
  }

  private observeSize() {
    if (!this.sizeObserver) return;
    const targets = new Set<Element>([
      this,
      ...this.renderRoot.querySelectorAll('.chrome-top, .controls, .captions.below'),
    ]);
    for (const target of this.sizeTargets) {
      if (!targets.has(target)) this.sizeObserver.unobserve(target);
    }
    for (const target of targets) {
      if (!this.sizeTargets.has(target)) this.sizeObserver.observe(target);
    }
    this.sizeTargets = targets;
    this.applyAutoHeight();
  }

  private fitBelowCaption() {
    const band = this.renderRoot.querySelector<HTMLElement>('.captions.below');
    const cue = band?.querySelector<HTMLElement>('.caption-cue');
    const parent = band?.parentElement;
    if (!band || !cue || !parent) {
      this.belowCaptionFitKey = '';
      return;
    }
    const style = getComputedStyle(band);
    const width = parent.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const key = `${width}|${style.font}|${cue.textContent}`;
    if (key === this.belowCaptionFitKey || width <= 0) return;
    this.belowCaptionFitKey = key;
    cue.style.fontSize = '';
    const naturalWidth = cue.scrollWidth;
    if (naturalWidth > width) {
      cue.style.fontSize = `${Math.max(12, parseFloat(style.fontSize) * width / naturalWidth)}px`;
    }
  }

  private setHostState(name: string, enabled: boolean) {
    if (enabled) this.hostInternals.states.add(name);
    else this.hostInternals.states.delete(name);
  }

  /**
   * Story aspect once known, otherwise the preload placeholder: element attribute,
   * then the `--dive-preload-aspect-ratio` custom property, then 16:9.
   */
  private resolvedAspect(style?: CSSStyleDeclaration): AspectRatio {
    const declared = this.story?.aspectRatio;
    if (declared) return parseAspectRatio(declared);
    const fromAttribute = this.preloadAspectRatio?.trim();
    const fromCss = style?.getPropertyValue('--dive-preload-aspect-ratio').trim();
    return parseAspectRatio(fromAttribute || fromCss || null, DEFAULT_PRELOAD_ASPECT);
  }

  private applyAutoHeight() {
    const topScrim = this.renderRoot.querySelector<HTMLElement>('.top-scrim');
    const controls = this.renderRoot.querySelector<HTMLElement>('.controls');
    if (topScrim && controls) topScrim.style.height = `${controls.getBoundingClientRect().height}px`;
    const style = getComputedStyle(this);
    const paddingWidth = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
    const aspect = this.resolvedAspect(style);
    const width = this.clientWidth - paddingWidth;
    let sizingRule = `:host { --aspect-ratio: ${aspectCss(aspect)}; }`;
    if (width > 0) {
      let height = width * aspect.height / aspect.width;
      const extras = this.activeUiMode() === 'inset'
        ? '.chrome-top, .controls, .captions.below'
        : '.captions.below';
      for (const element of this.renderRoot.querySelectorAll(extras)) {
        height += element.getBoundingClientRect().height;
      }
      if (style.boxSizing === 'border-box') {
        height += parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
          + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
      }
      sizingRule += ` :host { height: min(${height}px, 100dvh); }`;
    } else {
      sizingRule += ' :host { height: auto; }';
    }
    sizingRule += ' :host(:fullscreen) { height: 100%; aspect-ratio: auto; }';
    if (this.autoHeight !== sizingRule) {
      if (!this.sizingSheet) {
        this.sizingSheet = new CSSStyleSheet();
        this.shadowRoot!.adoptedStyleSheets = [...this.shadowRoot!.adoptedStyleSheets, this.sizingSheet];
      }
      this.sizingSheet.replaceSync(sizingRule);
      this.autoHeight = sizingRule;
    }
    if (width <= 0) return;
    this.applyStageScale();
  }

  private applyStageScale() {
    const wrap = this.ratioWrapper;
    const cell = this.pictureArea || this.videoSection || wrap;
    if (!wrap || !cell) {
      return;
    }
    const aspect = this.resolvedAspect(getComputedStyle(this));
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
    this.storyError = false;
    this.storyReadyEmitted = false;
    this.warnedSettingsLinks.clear();
    try {
      this.viewerUiMode = null;
      this.viewerCaptionsBelow = null;
      this.storyBaseUrl = new URL(url, document.baseURI).href;
      this.packSession = null;
      this.packedAudioKey = '';
      this.packedAudioVersion++;
      this.configuredAudioKey = '';
      this.packMediaReady = true;
      this.packMediaError = false;
      const urlState = readDiveUrlState();

      if (looksLikeDiveUrl(url)) {
        this.sceneReady = false;
        const session = await openDivePack(this.storyBaseUrl, { sceneId: urlState.sceneId, timeMs: urlState.timeMs });
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

      this.observeStage();
      const pending = this.pendingLanguage;
      const validPending = pending && this.languageOptions().some(item => item.code === pending);
      if (pending && !validPending) console.warn(`Cannot select unavailable player language: ${pending}`);
      this.playerLang = resolvePlayerLanguage(this.storyLanguages(), urlState.lang,
        validPending ? pending : playerDefaults().language);
      this.pendingLanguage = null;
      const startScene = urlState.sceneId
        ? this.story?.scenes.find((scene) => scene.id === urlState.sceneId)
        : undefined;
      const startTime = urlState.timeMs ?? startScene?.startTime ?? 0;
      this.currentTime = startTime;
      this.allAudioSpecs = this.story ? collectStoryAudio(this.story, this.storyBaseUrl) : [];
      this.applyLocaleMedia();
      this.captionTracks = this.story
        ? await resolveCaptionTracks(this.story.captions, this.storyBaseUrl)
        : [];
      // Captions start off at the player level, so a story that merely ships tracks
      // does not put text over the picture uninvited. configure({ captionsDefault: true })
      // opts a page in.
      this.captionsEnabled = (playerDefaults().captionsDefault ?? false)
        && this.captionTracks.some((track) => track.kind !== 'descriptions');
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
          this.activateScene(state.scene);
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
      this.sequencer.seek(startTime);
      this.notifyAdapterPlaybackState();
      if (!this.activeToolId) this.emitStoryReady();
      
    } catch (e) {
      this.storyError = true;
      if (!this.story) {
        this.playerLang = resolvePlayerLanguage(this.storyLanguages(), readDiveUrlState().lang, playerDefaults().language);
      }
      this.emitLoadError('story', e);
    }
  }

  private emitStoryReady() {
    if (this.storyReadyEmitted || this.storyError) return;
    this.storyReadyEmitted = true;
    this.packSession?.backfill(this.playerLang, this.currentTime, this.descriptionsEnabled);
    this.dispatchEvent(new CustomEvent('dive-story-ready', {
      bubbles: true, composed: true, detail: { src: this.storyBaseUrl },
    }));
  }

  private emitLoadError(phase: 'story' | 'scene' | 'media', error: unknown) {
    console.error(`Failed to load DIVE ${phase}:`, error);
    this.dispatchEvent(new CustomEvent('dive-load-error', {
      bubbles: true, composed: true,
      detail: { src: this.storyBaseUrl, phase, sceneId: phase === 'scene' ? this.activeToolId : null, error },
    }));
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

  private activateScene(scene: Story['scenes'][0]) {
    const switching = this.switchTool(scene);
    const version = this.toolSwitchVersion;
    void switching.catch(error => {
      if (version === this.toolSwitchVersion) this.failTool(error);
    });
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
      this.updateFrameTitles();
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
    if (this.sceneError) return;
    this.sceneError = true;
    this.sceneReady = false;
    this.toolFading = false;
    this.syncMedia(this.currentTime);
    this.resetUIHideTimer();
    this.emitLoadError('scene', error);
  }

  private retryTool = () => {
    const scene = this.story?.scenes.find((item) => item.id === this.activeToolId);
    if (!scene) return;
    const prepared = this.preparedTools.get(scene.id);
    if (prepared) this.disposePreparedTool(prepared);
    this.preparedTools.delete(scene.id);
    this.activateScene(scene);
  }

  private markToolReady() {
    this.sceneError = false;
    this.sceneReady = true;
    this.scheduleUIHideTimer();
    if (this.playWhenReady) {
      this.playWhenReady = false;
      this.beginPlayback();
    } else {
      this.notifyAdapterPlaybackState();
    }
    this.emitStoryReady();
  }

  private beginPlayback() {
    if (!this.sequencer) return;
    this.keyboardNavigationActive = false;
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
    this.languagesOpen = false;
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
      this.activeAdapter.setPlaybackState(this.isPlaying && this.sceneReady && this.packMediaReady, this.currentTime);
    }
    this.syncMedia(this.currentTime);
  }

  private syncMedia(timeMs: number) {
    this.ensurePackedAudio(timeMs);
    const hard = this.audioHardSeek;
    this.audioHardSeek = false;
    this.audioEngine.sync(timeMs, this.isPlaying && this.sceneReady && this.packMediaReady, { hard });
    this.sequencer?.hold(this.isPlaying && (!this.sceneReady || !this.packMediaReady || this.audioEngine.isHoldingStory));
    const tracks = captionTracksForLocale(this.captionTracks, this.playerLang, {
      captions: this.captionsEnabled,
      descriptions: this.descriptionsEnabled,
    });
    this.activeCues = tracks.flatMap((track) => cuesAtTime(track.cues, timeMs));
  }

  private toggleMute() {
    if (this.isMuted || this.volume === 0) {
      this.volume = this.lastNonZeroVolume;
      this.isMuted = false;
    } else {
      this.lastNonZeroVolume = this.volume;
      this.isMuted = true;
    }
    this.audioEngine.setVolume(this.volume);
    this.audioEngine.setMuted(this.isMuted);
  }

  private handleVolumeInput = (event: Event) => {
    const input = event.currentTarget as HTMLInputElement;
    const volume = Number(input.value);
    this.audioEngine.setVolume(volume);
    this.volume = volume;
    if (volume > 0) this.lastNonZeroVolume = volume;
    this.isMuted = volume === 0;
  };

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

    e.preventDefault();
    e.currentTarget.focus({ preventScroll: true });
    this.isScrubbing = true;
    this.scrubberElement = e.currentTarget;
    this.seekFromScrubberClientX(e.clientX, this.scrubberElement);

    window.addEventListener('pointermove', this.handleGlobalPointerMove);
    window.addEventListener('pointerup', this.handleGlobalPointerUp);
  }

  private handleTimelinePointerMove(event: PointerEvent) {
    if (!this.story || event.pointerType === 'touch' || !(event.currentTarget instanceof HTMLElement)) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (!bounds.width) return;
    const x = Math.max(0, Math.min(bounds.width, event.clientX - bounds.left));
    this.timelineHover = { x, time: x / bounds.width * this.story.duration };
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
    this.resetUIHideTimer();
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
      label: scene.label || scene.id,
      startTime: scene.startTime,
      endTime: scene.endTime,
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

  private applyLocaleMedia(forceSeek = false) {
    const available = this.packSession?.manifest?.version === 2
      ? this.packSession.availableAudio() : this.allAudioSpecs;
    const clips = filterAudioClips(available, this.playerLang, {
      descriptions: this.descriptionsEnabled,
    });
    const key = JSON.stringify(clips);
    if (key !== this.configuredAudioKey) {
      this.configuredAudioKey = key;
      this.audioEngine.configure(clips);
      this.audioHardSeek = true;
    }
    if (forceSeek) this.audioHardSeek = true;
    this.audioEngine.setMuted(this.isMuted);
    this.audioEngine.unlock();
    this.syncMedia(this.currentTime);
  }

  private ensurePackedAudio(timeMs: number) {
    const session = this.packSession;
    if (session?.manifest?.version !== 2) return;
    const names = session.audioFiles(this.playerLang, timeMs, this.descriptionsEnabled);
    const key = JSON.stringify([this.playerLang, this.descriptionsEnabled, names]);
    if (key === this.packedAudioKey) return;
    this.packedAudioKey = key;
    const version = ++this.packedAudioVersion;
    this.packMediaError = false;
    if (session.hasAll(names)) {
      this.packMediaReady = true;
      this.applyLocaleMedia();
      return;
    }
    this.packMediaReady = false;
    this.activeAdapter?.setPlaybackState?.(false, timeMs);
    void session.ensureFiles(names).then(() => {
      if (version !== this.packedAudioVersion || session !== this.packSession || !this.isConnected) return;
      this.packMediaReady = true;
      this.applyLocaleMedia();
      this.notifyAdapterPlaybackState();
    }).catch(error => {
      if (version !== this.packedAudioVersion || session !== this.packSession) return;
      this.packMediaError = true;
      this.emitLoadError('media', error);
    });
  }

  private retryPackedAudio = () => {
    this.packedAudioKey = '';
    this.syncMedia(this.currentTime);
  };

  setLanguage(code: string) {
    if (!this.story) {
      this.pendingLanguage = code;
      return;
    }
    if (this.playerLang === code) {
      return;
    }
    if (!this.languageOptions().some((item) => item.code === code)) {
      console.warn(`Cannot select unavailable player language: ${code}`);
      return;
    }
    this.playerLang = code;
    storeLanguage(code);
    this.applyLocaleMedia(true);
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
      this.languagesOpen = false;
      this.resetUIHideTimer();
      void this.updateComplete.then(() => this.renderRoot.querySelector<HTMLElement>('.settings select, .settings input, .settings a')?.focus());
    }
  };

  private toggleChapters = () => {
    this.chaptersOpen = !this.chaptersOpen;
    if (this.chaptersOpen) {
      this.settingsOpen = false;
      this.languagesOpen = false;
      this.focusCurrentDropdownOption('chapters');
    }
  };

  private toggleLanguages = () => {
    this.languagesOpen = !this.languagesOpen;
    if (!this.languagesOpen) return;
    this.settingsOpen = false;
    this.chaptersOpen = false;
    this.focusCurrentDropdownOption('languages');
  };

  private focusCurrentDropdownOption(drawer: 'chapters' | 'languages') {
    this.resetUIHideTimer();
    void this.updateComplete.then(() => {
      const panel = this.renderRoot.querySelector<HTMLElement>(`#${drawer}-drawer`);
      const option = panel?.querySelector<HTMLElement>('button[aria-current="true"]')
        || panel?.querySelector<HTMLElement>('button');
      option?.focus({ preventScroll: true });
      if (!panel || !option) return;
      const bounds = panel.getBoundingClientRect();
      const row = option.getBoundingClientRect();
      if (row.top < bounds.top) panel.scrollTop += row.top - bounds.top;
      else if (row.bottom > bounds.bottom) panel.scrollTop += row.bottom - bounds.bottom;
    });
  }

  private selectMenuLanguage(code: string) {
    this.setLanguage(code);
    this.languagesOpen = false;
    this.focusDrawerTrigger('languages-drawer');
  }

  private focusDrawerTrigger(drawer: string) {
    void this.updateComplete.then(() =>
      this.renderRoot.querySelector<HTMLElement>(`[aria-controls="${drawer}"]`)?.focus());
  }

  private handleDropdownOutsidePointerDown = (event: PointerEvent) => {
    const path = event.composedPath();
    for (const [selector, open] of [
      ['.chapter-menu-anchor', this.chaptersOpen],
      ['.language-menu-anchor', this.languagesOpen],
      ['.settings', this.settingsOpen],
    ] as const) {
      if (!open) continue;
      if (path.some(node => node instanceof Element
        && (node.matches(selector) || node.getAttribute('aria-controls') === 'settings-drawer'))) return;
    }
    if (!this.chaptersOpen && !this.languagesOpen && !this.settingsOpen) return;
    this.chaptersOpen = false;
    this.languagesOpen = false;
    this.settingsOpen = false;
    this.resetUIHideTimer();
  };

  private settingsLinkUrl(href: string): string | null {
    const key = `${this.storyBaseUrl}|${this.playerLang}|${href}`;
    const warn = (error: Error) => {
      if (this.warnedSettingsLinks.has(key)) return;
      this.warnedSettingsLinks.add(key);
      console.warn(`Skipping invalid settings link for ${this.playerLang}: ${href}`, error);
    };
    if (typeof href !== 'string' || !href.trim()) {
      warn(new Error('Settings link URL is empty'));
      return null;
    }
    let url: URL;
    try {
      url = new URL(href, this.storyBaseUrl);
    } catch (error) {
      warn(error instanceof Error ? error : new Error(String(error)));
      return null;
    }
    if (!['http:', 'https:', 'blob:'].includes(url.protocol)) {
      warn(new Error(`Unsupported settings link protocol: ${url.protocol}`));
      return null;
    }
    return url.href;
  }

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
    const restoreChaptersFocus = this.chaptersOpen;
    this.chaptersOpen = false;
    if (restoreChaptersFocus) void this.updateComplete.then(() => this.renderRoot.querySelector<HTMLElement>('[aria-controls="chapters-drawer"]')?.focus());
    this.ended = false;
    this.lastVisualState = null;
    this.audioHardSeek = true;
    this.sequencer.seek(scene.startTime);
  }

  private replay = () => {
    if (!this.sequencer) {
      return;
    }
    this.keyboardNavigationActive = false;
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
    if (event.defaultPrevented) return;
    if (event.key === 'Escape' && (this.settingsOpen || this.chaptersOpen || this.languagesOpen)) {
      const drawer = this.settingsOpen ? 'settings-drawer' : this.chaptersOpen ? 'chapters-drawer' : 'languages-drawer';
      this.settingsOpen = false;
      this.chaptersOpen = false;
      this.languagesOpen = false;
      event.preventDefault();
      this.focusDrawerTrigger(drawer);
      return;
    }
    const target = event.composedPath()[0] as HTMLElement | null;
    if (target instanceof HTMLElement) {
      if (target.isContentEditable || target.closest('textarea, select, input:not([type="range"])')) return;
      if (this.settingsOpen || this.chaptersOpen || this.languagesOpen) return;
      const focusedButton = target.closest('button, a, summary, [role="button"]');
      if (focusedButton && [' ', 'Enter'].includes(event.key)) return;
      const nativeRange = target.closest('input[type="range"]');
      const slider = target.closest('[role="slider"]');
      const navigationKeys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'];
      if ((nativeRange || slider) && navigationKeys.includes(event.key)) return;
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

  private handleSeekKeydown = (event: KeyboardEvent) => {
    if (!this.story || event.altKey || event.ctrlKey || event.metaKey) return;
    const delta = ({ ArrowLeft: -5000, ArrowDown: -5000, ArrowRight: 5000, ArrowUp: 5000,
      PageDown: -this.story.duration / 10, PageUp: this.story.duration / 10 } as Record<string, number>)[event.key];
    if (delta !== undefined) this.nudge(delta);
    else if (event.key === 'Home') this.nudge(-this.currentTime);
    else if (event.key === 'End') this.nudge(this.story.duration - this.currentTime);
    else return;
    event.preventDefault();
    event.stopPropagation();
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

  private renderDropdownChevron(open: boolean) {
    return html`<svg class="dropdown-chevron" viewBox="0 0 24 24" aria-hidden="true">
      <path d=${open ? 'M6 15l6-6 6 6' : 'M6 9l6 6 6-6'} fill="none" stroke="currentColor" stroke-width="2"/>
    </svg>`;
  }

  private renderVolumeControl(hasAudio: boolean, ui: ReturnType<typeof playerCopy>) {
    if (!hasAudio) return nothing;
    const level = this.isMuted ? 0 : this.volume;
    const silent = level === 0;
    return html`
      <div class="volume-control">
        <button type="button" class="icon-btn volume-button" @click=${this.toggleMute}
          @pointerdown=${(event: PointerEvent) => {
            if (event.pointerType === 'touch') (event.currentTarget as HTMLButtonElement).focus({ preventScroll: true });
          }}
          title=${silent ? ui.unmute : ui.mute} aria-label=${silent ? ui.unmute : ui.mute}
          aria-pressed=${silent}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M3 9v6h4l5 5V4L7 9H3z"/>
            ${silent
              ? svg`<path class="volume-stroke volume-muted" d="m16 8 6 8m0-8-6 8" stroke="currentColor" stroke-width="2"/>`
              : svg`
                <path class="volume-stroke volume-wave" d="M15 10a3 3 0 0 1 0 4" stroke="currentColor" stroke-width="2"/>
                ${level > 1 / 3 ? svg`<path class="volume-stroke volume-wave" d="M17 7a7 7 0 0 1 0 10" stroke="currentColor" stroke-width="2"/>` : nothing}
                ${level > 2 / 3 ? svg`<path class="volume-stroke volume-wave" d="M19 4a11 11 0 0 1 0 16" stroke="currentColor" stroke-width="2"/>` : nothing}
              `}
          </svg>
        </button>
        <div class="volume-popup">
          <input class="volume-slider" type="range" min="0" max="1" step="0.01"
            .value=${String(level)} aria-label=${ui.volume} aria-orientation="vertical"
            aria-valuetext="${Math.round(level * 100)}%" @input=${this.handleVolumeInput}/>
        </div>
      </div>
    `;
  }

  render() {
    const ui = playerCopy(this.playerLang, playerDefaults().playerText, this.story?.playerText);
    if (this.storyError) {
      return html`<div class="scene-error" role="alert" lang=${this.playerLang}>${ui.storyError}</div>`;
    }
    if (!this.story) {
      return html`<div>${ui.loadingStory}</div>`;
    }

    const duration = this.story.duration;
    const percent = Math.min(100, Math.max(0, (this.currentTime / duration) * 100));
    const timelineSections = this.getTimelineSections();
    const hoverTime = this.timelineHover?.time;
    const hoveredSection = hoverTime === undefined ? undefined
      : timelineSections.find(section => hoverTime >= section.startTime
        && (hoverTime < section.endTime || hoverTime === duration && section.endTime === duration));
    const hoveredScene = hoverTime === undefined ? undefined
      : this.story.scenes.find(scene => hoverTime >= scene.startTime
        && (hoverTime < scene.endTime || hoverTime === duration && scene.endTime === duration));
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

    const aspect = this.resolvedAspect();
    const hasCaptions = this.captionTracks.some((track) => track.kind !== 'descriptions');
    const hasDescriptions = this.allAudioSpecs.some((clip) => clip.role === 'descriptions')
      || this.captionTracks.some((track) => track.kind === 'descriptions');
    const hasAudio = this.audioEngine.hasAudio || this.allAudioSpecs.length > 0;
    const languages = this.languageOptions();
    const langPlacement = this.languagePlacement();
    const showLangMenu = langPlacement === 'menu';
    const poster = this.story.poster && !this.hasStarted ? this.story.poster : null;
    const title = resolveLocalized(this.story.title, this.playerLang);
    const showUiModeSetting = this.story.showUiModeSetting ?? playerDefaults().showUiModeSetting ?? true;
    const showCaptionLocationSetting = this.story.showCaptionLocationSetting ?? playerDefaults().showCaptionLocationSetting ?? true;
    const settingsLinks = (this.story.settingsLinks || []).flatMap(link => {
      const href = this.settingsLinkUrl(resolveLocalized(link.href, this.playerLang));
      return href ? [{ link, href }] : [];
    });
    const hasSettings = showUiModeSetting || (hasCaptions && showCaptionLocationSetting)
      || hasDescriptions || settingsLinks.length > 0;
    const captionsBelow = this.activeCaptionsBelow();
    const chromeMode = this.activeUiMode();
    const chromeHidden = chromeMode === 'autohide' && this.isUIHidden;
    const showCatcher = this.isPlaying && (chromeMode === 'autohide' || this.pauseOnInteractActive());
    const captionLayer = this.captionsEnabled && (this.activeCues.length || captionsBelow) ? html`
      <div class="captions ${captionsBelow ? 'below' : chromeMode === 'autohide' && !chromeHidden ? 'clear-controls' : ''}" part="captions" aria-hidden="true">
        ${captionsBelow
          ? html`<div class="caption-cue">${this.activeCues.map(cue => cue.text).join(' ').replace(/\s+/g, ' ').trim()}</div>`
          : this.activeCues.map((cue) => html`<div class="caption-cue">${cue.text}</div>`)}
      </div>
    ` : '';

    const videoSection = html`
      <div class="video-section">
        <div class="picture-area">
        <div
          class="video-ratio-wrapper"
          style="--aspect-ratio: ${aspectCss(aspect)}; --ar-w: ${aspect.width}; --ar-h: ${aspect.height};"
        >
          <div id="canvas-container" class="${this.toolFading ? 'fading' : ''}" part="canvas"></div>
          ${showCatcher ? html`<div class="play-catcher" @pointerdown=${this.handlePlayCatcher}></div>` : ''}
          ${poster ? html`<img class="poster" part="poster" src="${poster}" alt="" />` : ''}
          ${this.packMediaError
            ? html`<div class="scene-error" role="alert">${ui.audioError}<button @click=${this.retryPackedAudio}>${ui.retry}</button></div>`
            : this.sceneError
            ? html`<div class="scene-error" role="alert">${ui.sceneError}<button @click=${this.retryTool}>${ui.retry}</button></div>`
            : !this.sceneReady ? html`<div class="buffer-spinner" part="buffer" aria-label=${ui.loadingScene}></div>`
            : !this.packMediaReady ? html`<div class="buffer-spinner media-buffer" part="buffer" role="status" aria-label=${ui.loadingAudio}></div>` : ''}
          
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

          ${captionsBelow ? '' : captionLayer}

          ${this.ended ? html`
            <div class="end-screen" part="end-screen">
              <h2>${title || ui.end}</h2>
              <button @click=${this.replay}>${ui.replay}</button>
            </div>
          ` : ''}
        </div>
        </div>
        ${captionsBelow ? captionLayer : ''}
      </div>
    `;
    const playButton = html`
      <button
        class="icon-btn play-btn"
        part="play-button"
        @click=${this.togglePlay}
        title="${this.isPlaying ? ui.pause : ui.play}"
        aria-label="${this.isPlaying ? ui.pause : ui.play}"
      >
        ${this.isPlaying
          ? html`<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#fff" d="M6 5h4v14H6V5zm8 0h4v14h-4V5z"/></svg>`
          : html`<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#fff" d="M8 5v14l11-7z"/></svg>`}
        <span class="play-label" aria-hidden="true"
          style=${this.story?.showPlayLabel === undefined ? '' : `display: ${this.story.showPlayLabel ? 'inline' : 'none'}`}
        >${this.isPlaying ? ui.pause : ui.play}</span>
      </button>
    `;

    return html`
      <div class="chrome-top">
      ${chromeMode === 'autohide' ? html`<div class="top-scrim ${chromeHidden ? 'hidden' : ''}" aria-hidden="true"></div>` : ''}
      <div class="dropdown-anchor chapter-menu-anchor">
      <button type="button"
        class="dropdown-button chapter-button ${chromeHidden ? 'hidden' : ''}"
        @click=${this.toggleChapters}
        title=${ui.chapters}
        aria-label=${ui.chapters}
        aria-haspopup="true"
        aria-expanded=${this.chaptersOpen}
        aria-controls="chapters-drawer"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
          <circle cx="4" cy="6" r="1.5"/><circle cx="4" cy="12" r="1.5"/><circle cx="4" cy="18" r="1.5"/>
          <path d="M9 6h11M9 12h11M9 18h11" fill="none" stroke="currentColor" stroke-width="2"/>
        </svg>
        <span class="dropdown-label">${ui.chapters}</span>
        ${this.renderDropdownChevron(this.chaptersOpen)}
      </button>
      ${this.chaptersOpen ? html`
        <div class="drawer dropdown chapters" part="chapters" id="chapters-drawer" role="region" aria-label=${ui.chapters}>
          ${this.story.scenes.map((scene) => html`
            <button type="button" aria-current=${scene.id === this.activeToolId}
              @click=${() => this.jumpToScene(scene.id)}
            >${resolveLocalized(scene.label || scene.id, this.playerLang)}</button>
          `)}
        </div>
      ` : ''}
      </div>
      ${chromeMode === 'inset' ? html`
        <div class="chrome-help" part="player-help"><slot name="player-help">${ui.playerHelp}</slot></div>
      ` : ''}
      <div class="chrome-top-right">
        ${showLangMenu ? html`
          <div class="dropdown-anchor language-menu-anchor" part="lang-toggle">
            <button type="button" class="dropdown-button ${chromeHidden ? 'hidden' : ''}"
              aria-label=${ui.language} title=${ui.language} aria-haspopup="true"
              @click=${this.toggleLanguages} aria-expanded=${this.languagesOpen} aria-controls="languages-drawer">
              <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/>
              </svg>
              <span class="dropdown-label">${ui.language}</span>
              ${this.renderDropdownChevron(this.languagesOpen)}
            </button>
            ${this.languagesOpen ? html`
              <div class="drawer dropdown languages" id="languages-drawer" role="region" aria-label=${ui.language}>
                ${languages.map(item => html`
                  <button type="button" part="language-button ${item.code === this.playerLang ? 'active-language-button' : ''}"
                    lang=${item.code} aria-current=${item.code === this.playerLang}
                    @click=${() => this.selectMenuLanguage(item.code)}>${item.label}</button>
                `)}
              </div>
            ` : ''}
          </div>
        ` : ''}
        ${langPlacement === 'inline' ? html`
          <div class="lang-toggle ${chromeHidden ? 'hidden' : ''} ${hasSettings ? '' : 'solo'}" part="lang-toggle" role="group" aria-label=${ui.language}
            style="--language-count: ${languages.length}; --language-index: ${Math.max(0, languages.findIndex(item => item.code === this.playerLang))}">
            ${languages.map((item) => html`
              <button
                type="button"
                part="language-button ${item.code === this.playerLang ? 'active-language-button' : ''}"
                lang=${item.code}
                title=${item.label}
                aria-label="${item.code.toUpperCase()} ${item.label}"
                aria-current=${item.code === this.playerLang}
                @click=${() => this.setLanguage(item.code)}
              ><span class="language-code" aria-hidden="true">${item.code.toUpperCase()}</span><span class="language-name" aria-hidden="true">${item.label}</span></button>
            `)}
          </div>
        ` : ''}

      </div>
      </div>

      ${videoSection}

      <div class="controls ${chromeHidden ? 'hidden' : ''}" part="controls">
        ${playButton}
        ${this.renderVolumeControl(hasAudio, ui)}
        ${html`<div class="time-display" part="time-display">
          <span>${this.formatTime(this.currentTime)} / ${this.formatTime(duration)}</span>
        </div>`}
        <div class="scrubber" part="scrubber" role="slider" tabindex="0"
          aria-label=${ui.progress} aria-valuemin="0" aria-valuemax=${Math.floor(duration / 1000)}
          aria-valuenow=${Math.floor(this.currentTime / 1000)}
          aria-valuetext="${this.formatTime(this.currentTime)} / ${this.formatTime(duration)}"
          @keydown=${this.handleSeekKeydown} @pointerdown=${this.handleScrubPointerDown}
          @pointermove=${this.handleTimelinePointerMove} @pointerleave=${() => { this.timelineHover = null; }}>
          <div class="timeline-sections">
          ${timelineSections.map((section, index) => {
            const startPercent = (section.startTime / duration) * 100;
            const widthPercent = ((section.endTime - section.startTime) / duration) * 100;
            const color = section.color || 'var(--dive-scrubber-bg, #3f3f3f)';
            const showLabel = widthPercent >= 8;

            return html`
              <div
                class="section-band ${index === 0 ? 'first' : index === timelineSections.length - 1 ? 'last' : ''}"
                style="left: ${startPercent}%; width: ${widthPercent}%; background: var(--dive-section-bg, ${color});"
              >
                ${showLabel ? html`<span class="section-label">${resolveLocalized(section.label, this.playerLang)}</span>` : ''}
              </div>
            `;
          })}
          </div>

          <div class="progress" style="--progress: ${percent}%"></div>
          <div class="playhead" aria-hidden="true" style="left: clamp(0px, calc(${percent}% - 2px), calc(100% - 4px));"></div>
          
          <!-- Scene Markers -->
          ${this.story.scenes.filter(s => !timelineSections.some(section => section.startTime === s.startTime)).map(s => {
            const pos = (s.startTime / duration) * 100;
            return html`<div class="scene-marker" style="left: ${pos}%"></div>`;
          })}
          ${timelineSections.map((section) => {
            const pos = (section.startTime / duration) * 100;
            const active = this.currentTime >= section.startTime
              && (this.currentTime < section.endTime || (this.currentTime === duration && section.endTime === duration));
            return html`<div class="scene-marker chapter-marker ${active ? 'active' : ''} ${this.currentTime >= section.startTime ? 'visited' : ''}"
              style="left: ${pos}%;"></div>`;
          })}
          ${this.timelineHover && (hoveredSection || hoveredScene) ? html`
            <div class="timeline-tooltip" aria-hidden="true" style="left: ${this.timelineHover.x}px">
              ${hoveredSection ? html`<span class="timeline-tooltip-heading">${resolveLocalized(hoveredSection.label, this.playerLang)}</span>` : ''}
              ${hoveredScene ? html`<span class="timeline-tooltip-subheading">${resolveLocalized(hoveredScene.label || hoveredScene.id, this.playerLang)}</span>` : ''}
            </div>
          ` : ''}
        </div>

        ${hasCaptions ? html`
          <button
            class="icon-btn captions-btn"
            @click=${this.toggleCaptions}
            title="${this.captionsEnabled ? ui.hideCaptions : ui.showCaptions}"
            aria-label="${this.captionsEnabled ? ui.hideCaptions : ui.showCaptions}"
            aria-pressed=${this.captionsEnabled}
          >
            ${this.captionsEnabled
              ? html`<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#fff" d="M19 4H5c-1.11 0-2 .9-2 2v12c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm-8 7H9.5v-.5h-2v3h2V13H11v1c0 .55-.45 1-1 1H7c-.55 0-1-.45-1-1v-4c0-.55.45-1 1-1h3c.55 0 1 .45 1 1v1zm7 0h-1.5v-.5h-2v3h2V13H18v1c0 .55-.45 1-1 1h-3c-.55 0-1-.45-1-1v-4c0-.55.45-1 1-1h3c.55 0 1 .45 1 1v1z"/></svg>`
              : html`<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M11 11H9.5v-.5h-2v3h2V13H11v1c0 .55-.45 1-1 1H7c-.55 0-1-.45-1-1v-4c0-.55.45-1 1-1h3c.55 0 1 .45 1 1v1zm7 0h-1.5v-.5h-2v3h2V13H18v1c0 .55-.45 1-1 1h-3c-.55 0-1-.45-1-1v-4c0-.55.45-1 1-1h3c.55 0 1 .45 1 1v1z"/></svg>`}
          </button>
        ` : ''}

        ${hasSettings ? html`
          <button type="button" class="icon-btn settings" @click=${this.toggleSettings}
            title=${ui.settings} aria-label=${ui.settings} aria-expanded=${this.settingsOpen} aria-controls="settings-drawer">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.06-.94l2.03-1.58-1.92-3.32-2.39.96a7.2 7.2 0 0 0-1.63-.94L14.9 3h-5l-.36 2.7a7.2 7.2 0 0 0-1.63.94l-2.39-.96L3.6 9l2.03 1.58a7 7 0 0 0 0 1.88L3.6 14l1.92 3.32 2.39-.96a7.2 7.2 0 0 0 1.63.94L9.9 20h5l.36-2.7a7.2 7.2 0 0 0 1.63-.94l2.39.96L21.2 14l-2.03-1.58zM12.4 15a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z"/></svg>
          </button>
        ` : ''}
        <button class="icon-btn" @click=${this.toggleFullscreen} title=${ui.fullscreen} aria-label=${ui.fullscreen}>
          ${this.isFullscreen
            ? html`<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#fff" d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"/></svg>`
            : html`<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#fff" d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>`}
        </button>
      ${hasSettings && this.settingsOpen ? html`
        <div class="drawer settings" part="settings" id="settings-drawer" role="region" aria-label=${ui.settings}>
          <h3>${ui.settings}</h3>
          ${showUiModeSetting ? html`
            <label class="setting-select">
              <span>${ui.playerLayout}</span>
              <select class="layout-setting" .value=${this.viewerUiMode || 'default'}
                @change=${(event: Event) => {
                  if (!(event.currentTarget instanceof HTMLSelectElement)) return;
                  this.viewerUiMode = parseUiMode(event.currentTarget.value);
                  this.resetUIHideTimer();
                }}>
                <option value="default">${ui.defaultLayout}</option>
                <option value="autohide">${ui.autohideLayout}</option>
                <option value="inset">${ui.insetLayout}</option>
              </select>
            </label>
          ` : ''}
          ${hasCaptions && showCaptionLocationSetting ? html`
            <label class="setting-select">
              <span>${ui.captionLocation}</span>
              <select class="caption-location-setting" .value=${captionsBelow ? 'below' : 'overlaid'}
                @change=${(event: Event) => {
                  if (!(event.currentTarget instanceof HTMLSelectElement)) return;
                  this.viewerCaptionsBelow = event.currentTarget.value === 'below';
                }}>
                <option value="overlaid">${ui.captionsOverlaid}</option>
                <option value="below">${ui.captionsBelow}</option>
              </select>
            </label>
          ` : ''}
          ${hasDescriptions ? html`
            <label>
              <input
                type="checkbox"
                .checked=${this.descriptionsEnabled}
                @change=${() => { this.descriptionsEnabled = !this.descriptionsEnabled; this.applyLocaleMedia(true); }}
              />
              ${ui.audioDescription}
            </label>
          ` : ''}
          ${settingsLinks.map(({ link, href }) => html`
            <a href=${href}
              download=${link.download === true ? '' : typeof link.download === 'string' || typeof link.download === 'object'
                ? resolveLocalized(link.download, this.playerLang) : nothing}
              target=${link.newTab ? '_blank' : nothing} rel=${link.newTab ? 'noopener noreferrer' : nothing}
            >${resolveLocalized(link.label, this.playerLang)}</a>
          `)}
        </div>
      ` : ''}
      </div>
      
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
