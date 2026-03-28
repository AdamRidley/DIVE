# Specification: DIVE (Directed Interactive Video/Visualisation Experience)

## 1. Concept & Descriptive Overview (The Consumer Experience)

This framework provides an "Interruptible Narrative Visualization (INV)." It bridges the gap between a curated, author-driven data story (like a video) and a user-driven exploratory tool (like an interactive dashboard).

**The Consumer Interface:**

* **The Canvas:** The main viewing area displays the active interactive visualization (e.g., a map, scatterplot, or bar chart).
* **The Narrative Layer:** Contextual text, captions, or audio play dynamically as the visualization automatically animates to highlight relevant data points.
* **The Playback Controls:** At the bottom of the screen, users see familiar media controls (Play, Pause, Forward, Back) and a segmented timeline scrubber.
* **Chapter Markers:** The timeline visually indicates when the narrative transitions from one visualization tool or scene to another.

**The Core Mechanic:**

1. **Watch Mode:** The user hits "Play." The timeline progresses, and the framework automatically pans, zooms, filters, and highlights data to tell a specific story.
2. **Explore Mode:** The user hits "Pause" (or interacts directly with the canvas). The automated narrative stops. The user is now free to click, filter, and explore the data freely using the native capabilities of the visualization tool.
3. **The Resume Handoff:** When the user hits "Play" again, the framework instantly recalls the cached state of the narrative at that exact timestamp, seamlessly snapping the visualization back to the curated path and continuing the story.

---

## 2. Authoring Experience (The Creator's Perspective)

The framework must be highly integrable and user-friendly for creators, abstracting the complexity of timeline management away from the data visualization code.

* **Script-Driven:** Authors create stories using a structured, human-readable format (e.g., JSON). The script defines the timeline, the text/audio narrative, and the state commands (e.g., "At 0:15, pan to Europe and highlight France").
* **Tool Agnostic:** Authors are not locked into one chart type. A single script can load a map for the first chapter, transition to a line chart for the second, and end on a scatterplot.
* **Accessible by Default:** The authoring format forces or heavily encourages the inclusion of text alternatives for all visual states to ensure screen reader compatibility.

---

## 3. Core Architecture & Technical Implementation (Definite Requirements)

To achieve scalability, seamless pausing/resuming, and broad compatibility, the framework relies on three core technical pillars:

### A. The Sequencer & Virtual State Cache

The "brain" of the framework. It reads the author's script and maintains a running clock.

* As the clock ticks, it updates a **Virtual State Object** in memory. This represents exactly what the visualization *should* look like at any given millisecond.
* When a user pauses and interacts with the live chart, the actual visual state is "dirtied," but the Virtual State Object remains frozen and pristine.
* Upon resuming, the Sequencer pushes the Virtual State Object to the visualizer, guaranteeing a perfect, glitch-free snap back to the narrative timeline.

### B. The Adapter Pattern

To ensure the framework can integrate with any existing interactive library (D3.js, Apache ECharts, Mapbox, Plotly, etc.), it strictly prohibits direct communication between the Sequencer and the visualization.

* **The Contract:** The framework sends universal commands (e.g., `{"action": "zoom", "target": "node-A"}`).
* **The Adapter:** A lightweight middleman script specific to the chosen library. An `EChartsAdapter` translates the universal command into native ECharts API calls, while a `MapboxAdapter` translates it into Mapbox API calls.
* *Benefit:* Entirely new chart libraries can be integrated in the future simply by writing a new adapter, without touching the core framework code.

---

## 4. Technical Implementation & Architecture

### A. The Web Component (`<dive-video>`)

To simplify publishing, the framework is delivered as a **Custom Web Element** using **Shadow DOM**.

* **Encapsulation:** Visualization libraries and CSS are scoped internally to prevent style bleeding.
* **Dynamic Loading:** The component lazy-loads the required **Adapter** and library only when needed.

### B. The Adapter Pattern

To remain library-agnostic (D3.js, Mapbox, ECharts, etc.), D.I.V.E. uses an **Adapter Interface**.

* **The Contract:** The engine sends universal state commands; the Adapter translates them into library-specific API calls (e.g., `map.flyTo` or `chart.setOption`).

### C. The Seamless Handoff Logic

To ensure a glitch-free transition between the MP4 and the live tool:

1. **Background Sync:** The engine calculates the "Virtual State" from the logic script in sync with the `video.currentTime`.
2. **The Pause Trigger:** Upon pause, the engine fires `setState()` to the hidden interactive tool.
3. **The Cross-Fade:** A rapid (~100ms) visual transition swaps the video frame for the live interactive canvas.
4. **The Resume Snap-Back:** On resume, the user's "dirty" state is discarded, and the engine re-applies the exact narrative state before restarting the video.

---

## 5. Accessibility (A11y) & Parallel DOM

D.I.V.E. implements a **Parallel DOM Strategy** to ensure the experience is equivalent for screen-reader users.

* **Shadow Semantic Layer:** A hidden, visually obscured HTML layer is maintained behind the visual presentation.
* **Narrative A11y:** Narrative text is pushed to an `aria-live="polite"` region in sync with the video timeline.
* **Interactive A11y:** When paused, the framework generates a dynamic HTML `<table>` of the current data state, allowing keyboard-based data exploration.

---

## 6. Development vs. Publishing Workflow

* **Development Mode:** (Undecided) Provides a "Record UI" where creators interact with the tool to auto-generate the `.dive` JSON script and log state keyframes.
* **Publishing Mode:** Compiles the video, script, and assets into the Manifest for distribution via the `<dive-video>` tag.

---

## 7. Open Decisions & Optional Features (To Be Evaluated)

The following features are conceptually sound but require further evaluation based on technical constraints and project scope:

* **Pre-Rendered MP4 Handoff:**

  * *Concept:* On publish, the automated narrative renders as a highly optimized `.mp4`. When the user pauses the video on the web, a rapid crossfade swaps the paused video frame for the live, interactive DOM element.
  * *Goal:* Maximize battery life and performance on mobile devices.
* **Transition Handling Methodology:**

  * *Option 1 (Single-Event):* Event + Duration + Target State. Defers smooth interpolation to the charting library's native animation engine (e.g., Mapbox `flyTo`).
  * *Option 2 (Keyframe-Based):* Granular P-Frames. The framework calculates the math between states frame-by-frame and pushes micro-updates. Necessary for libraries lacking robust built-in state morphing.
  * *Current Stance:* The framework may need to support both methods depending on the adapter in use.
* **Record Mode UI (Authoring Tool):**

  * *Concept:* A graphical interface where creators hit "Record," interact with their chart natively, and the framework automatically captures the states to generate the JSON timeline script.
* **Cross-Tool Visual Transitions:**

  * *Concept:* Standardized visual bumpers (e.g., fade to black, slide) managed by the framework to gracefully hide the teardown of one tool and the mounting of the next between chapters.
* **Hybrid Rendering:** Possibility of overlaying a transparent interactive canvas *over* the playing video for "hotspot" interactions without pausing.
* **Manifest Compiler:** A CLI tool to package and optimize video bitrates and data assets for production.

