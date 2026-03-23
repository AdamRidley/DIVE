import { LitElement, html, css, PropertyValueMap } from 'lit';
import { customElement, property, state, query } from 'lit/decorators.js';
import { Sequencer } from '../core/Sequencer';
import { Story, NarrativeState } from '../core/types';
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

@customElement('dive-video')
export class DiveVideo extends LitElement {
  @property({ type: String }) src = ''; // URL to the story JSON

  @state() private story: Story | null = null;
  @state() private isPlaying = false;
  @state() private currentTime = 0;
  @state() private activeNarrativeState: NarrativeState | null = null;
  @state() private activeToolId: string | null = null;

  @query('#canvas-container') private canvasContainer!: HTMLElement;

  private sequencer: Sequencer | null = null;
  private activeAdapter: IAdapter | null = null;
  private lastVisualState: any = null;

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
    #canvas-container {
      width: 100%;
      height: calc(100% - 60px); /* Leave room for controls */
      background: #f4f4f4;
      position: relative;
    }
    /* SVG Styling inside Shadow DOM via adapter requires standard CSS vars or global bleed, but for PoC we'll inject via Lit if needed. D3 inserts inline styles. */

    .overlays {
      position: absolute;
      top: 0; left: 0; right: 0; bottom: 60px;
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
    .pos-center { top: 50%; left: 50%; transform: translate(-50%, -50%); }
    .pos-bottom { bottom: 20px; left: 50%; transform: translateX(-50%); }
    .pos-top { top: 20px; left: 50%; transform: translateX(-50%); }
    
    .controls {
      position: absolute;
      bottom: 0;
      width: 100%;
      height: 60px;
      background: #222;
      display: flex;
      align-items: center;
      padding: 0 10px;
      box-sizing: border-box;
      color: white;
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
      background: #555;
      margin: 0 15px;
      cursor: pointer;
      border-radius: 10px;
      overflow: hidden;
    }
    .progress {
      position: absolute;
      top: 0;
      left: 0;
      height: 100%;
      background: #007bff;
      pointer-events: none;
    }
    .scene-marker {
      position: absolute;
      top: 0;
      width: 2px;
      height: 100%;
      background: #fff;
    }
    .time-display {
      font-size: 12px;
      min-width: 80px;
      text-align: right;
    }
  `;

  protected async firstUpdated() {
    if (this.src) {
      await this.loadStory(this.src);
    }
  }

  private async loadStory(url: string) {
    try {
      const response = await fetch(url);
      this.story = await response.json();
      
      this.sequencer = new Sequencer(this.story!, (state) => {
        this.currentTime = state.time;
        this.activeNarrativeState = state;
        
        // Handle Scene / Adapter Loading
        if (state.scene && state.scene.id !== this.activeToolId) {
          this.switchTool(state.scene);
        }

        // Pass visual state to active adapter
        if (this.activeAdapter && state.visualState && state.visualState !== this.lastVisualState) {
          this.activeAdapter.setState(state.visualState, state.time);
          this.lastVisualState = state.visualState;
        }
      });
      
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
      // In a real scenario, data might be fetched dynamically via scene.data URL
      // Here we assume it's inline or fetched immediately
      this.fetchDataAndMount(scene.data);
    }
  }

  private async fetchDataAndMount(dataUrl: string) {
    // We will simulate data fetching if it's a URL, or just pass mock data here since we are rendering locally.
    // For PoC, the story.json will contain the data directly if it's an array, or a URL.
    try {
      let data = [];
      if (typeof dataUrl === 'string' && dataUrl.startsWith('/')) {
        const res = await fetch(dataUrl);
        data = await res.json();
      } else {
        data = dataUrl as unknown as any[]; // Assumed inline
      }
      this.activeAdapter?.mount(this.canvasContainer, data);
    } catch (e) {
      console.error("Failed to load data for tool:", e);
    }
  }

  private togglePlay() {
    if (!this.sequencer) return;
    
    if (this.isPlaying) {
      this.sequencer.pause();
      this.isPlaying = false;
      // In Explore Mode -> Let user interact freely
      // The canvas container pointer-events could be toggled here.
    } else {
      // Snapback will happen naturally because we reset the lastVisualState
      this.lastVisualState = null;
      this.sequencer.play();
      this.isPlaying = true;
    }
  }

  private handleScrub(e: MouseEvent) {
    if (!this.sequencer || !this.story) return;
    
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const percent = (e.clientX - rect.left) / rect.width;
    const timeMs = percent * this.story.duration;
    
    this.lastVisualState = null; // Force snapback on scrub
    this.sequencer.seek(timeMs);
    // If not playing, the seek manually pushed an update to snapshot.
  }

  private formatTime(ms: number) {
    const totalSeconds = Math.floor(ms / 1000);
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  render() {
    if (!this.story) {
      return html`<div>Loading Story...</div>`;
    }

    const duration = this.story.duration;
    const percent = (this.currentTime / duration) * 100;

    return html`
      <div id="canvas-container"></div>
      
      <!-- Overlay Layer -->
      <div class="overlays">
        ${this.activeNarrativeState?.activeOverlays.map(o => html`
          <div class="overlay-item pos-${o.position}">
            ${o.type === 'text' ? html`<p>${o.content}</p>` : html`<img src="${o.content}" width="100%" />`}
          </div>
        `)}
      </div>

      <!-- Controls Layer -->
      <div class="controls">
        <button @click=${this.togglePlay}>${this.isPlaying ? 'Pause' : 'Play'}</button>
        
        <div class="scrubber" @click=${this.handleScrub}>
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
      </div>
      
      <!-- Accessibility Layer: Parallel DOM (Hidden visually) -->
      <div aria-live="polite" class="sr-only" style="position: absolute; width: 1px; height: 1px; overflow: hidden;">
        ${this.activeNarrativeState?.activeOverlays.filter(o => o.type === 'text').map(o => o.content).join(' ')}
      </div>
      
      <!-- Screen Reader Data Context -->
      <div class="sr-only" style="position: absolute; width: 1px; height: 1px; overflow: hidden;">
        <h3>${this.activeToolId} Data</h3>
        ${!this.isPlaying ? html`
          <table>
            <caption>Current data view for exploration</caption>
            <tbody>
              ${Array.isArray(this.story?.scenes.find(s => s.id === this.activeToolId)?.data) 
                ? (this.story?.scenes.find(s => s.id === this.activeToolId)?.data as unknown as any[]).map((d: any) => html`
                <tr>${Object.entries(d).map(([k, v]) => html`<td>${k}: ${v}</td>`)}</tr>
              `) : html`<tr><td>Data loading or external</td></tr>`}
            </tbody>
          </table>
        ` : ''}
      </div>
    `;
  }
}
