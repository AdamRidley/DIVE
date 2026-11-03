# DIVE (Directed Interactive Video/Visualisation Experience)

DIVE is a framework for creating "Interruptible Narrative Visualizations (INV)." It bridges the gap between curated, author-driven data stories (like videos) and user-driven exploratory tools (like interactive dashboards).

## Core Concept

- **Watch Mode:** An automated narrative plays, panning, zooming, and highlighting data to tell a specific story.
- **Explore Mode:** Users can pause the narrative at any time to freely interact with and explore the underlying data using the native visualization tool's capabilities.
- **Resume Handoff:** Resuming playback instantly snaps the visualization back to the curated narrative path, continuing the story seamlessly.

## Architecture Overview

- **Library Agnostic:** Uses an Adapter Pattern to integrate with any interactive library (e.g., D3.js, Apache ECharts, Mapbox).
- **Web Component:** Delivered as a Custom Web Element (`<dive-video>`) for simple integration and encapsulation.
- **State Management:** A Sequencer and Virtual State Cache maintain perfect synchronization between the narrative timeline and the interactive chart.

For full technical details, see the [DIVE Framework Specification](DIVE-framework-spec.md).

## Install

```bash
npm install dive-video
```

The package name is `dive-video` because `dive` is already taken on npm. Importing the module registers the `<dive-video>` custom element.

```js
import 'dive-video';
```

Or import the public API:

```js
import { registerTool } from 'dive-video';
```

## CDN

After a version is published to npm, jsDelivr and unpkg serve it automatically:

Live demo (GitHub Pages): https://adamridley.github.io/DIVE/

The demo loads `dive-video` from jsDelivr and plays a same-origin `wealth.dive` pack.

```html
<script type="module" src="https://cdn.jsdelivr.net/npm/dive-video@1.2.1/dist/dive.js"></script>
<dive-video src="./wealth.dive"></dive-video>
```

Classic (non-module) script tag:

```html
<script src="https://cdn.jsdelivr.net/npm/dive-video@1.0.0/dist/dive.iife.js"></script>
<dive-video src="./story.json"></dive-video>
```

The IIFE build exposes `window.DIVE` (`DiveVideo`, `registerTool`, `configure`, `Sequencer`).

Story JSON can include `aspectRatio` (default `9:16`), `audio` (URL or clip objects), and `captions` (WebVTT URL or `{ startTime, endTime, text }` cues). If you only set the element's width, it sizes its height from the aspect ratio and letterboxes when the box is forced (explicit height or fullscreen).

Use `<dive-video src="./story.json" muted></dive-video>` to start with sound off; the speaker control enables it on demand. The reflected `isMuted` property also supports programmatic changes. Player controls have built-in English and Welsh text; other languages (or rewording) come from `playerText` (see below). `dive-language-change` emits `{ lang }` in its event detail when the active language changes.

### Interaction, languages, and theming

- `pauseOnInteract` (boolean) can be set on the story, a scene, or a keyframe `state`. The most specific value wins. When true, tapping a playing tool pauses it (autohide's first tap still just reveals the chrome) and so does an iframe `DIVE_INTERACT`. Interaction never resumes playback.
- `languageToggle` on the story (or the `language-toggle` attribute) places the language picker: `menu` (settings cog, default), `inline` (EN/CY pill in the chrome), `auto` (inline for exactly two languages, menu otherwise), or `none`.
- `playerText` sets player UI strings per language, e.g. `{ "fr": { "play": "Lire", "pause": "Pause" } }`. Keys: `loadingStory`, `loadingScene`, `end`, `replay`, `sceneError`, `retry`, `chapters`, `language`, `settings`, `play`, `pause`, `mute`, `unmute`, `hideCaptions`, `showCaptions`, `fullscreen`, `captions`, `audioDescription`, `data`, `dataView`, `dataLoading`. Missing keys fall back to English. Story `playerText` beats `configure({ playerText })`, which beats the built-in text.
- Colours and font are CSS custom properties, so a page can rebrand the player without touching it:

```css
dive-video {
  --dive-accent: #0a7c6b;           /* active language, progress bar */
  --dive-accent-contrast: #fff;
  --dive-font: "Segoe UI", sans-serif;
  --dive-chrome-bg: #111214;        /* inset bars */
  --dive-chrome-fg: #fff;           /* icons and chrome text */
  --dive-stage-bg: #f4f4f4;
  --dive-scrubber-bg: #3f3f3f;
  --dive-progress: rgba(10, 124, 107, 0.55); /* defaults to the accent at 55% */
  --dive-drawer-bg: rgba(10, 10, 12, 0.88);
  --dive-button-bg: #444;
  --dive-button-hover-bg: #666;
}
```

A downstream build can set house defaults once with `configure()` (or `DiveVideo.configure()`). Story values and page CSS still win:

```js
import { configure } from 'dive-video';

configure({
  languages: [{ code: 'en', label: 'English', default: true }, { code: 'cy', label: 'Cymraeg' }],
  languageToggle: 'auto',
  pauseOnInteract: true,
  uiMode: 'inset',
  theme: { '--dive-accent': '#0a7c6b' },
});
```

## Local development

```bash
npm ci
npm run dev
```

- PoC: http://localhost:5173/
- Wealth and Health example: http://localhost:5173/examples/the_wealth_and_health_of_nations/

```bash
npm run test:ci          # typecheck + library build + dist smoke check
npm run build            # ESM + IIFE + typings → dist/
npm run build:example    # example site → dist-example/
```

## CI/CD

This repository now includes two GitHub Actions workflows:

- `.github/workflows/ci.yml`
- Runs on pull requests and pushes to `main`.
- Installs dependencies with `npm ci`.
- Runs `npm run test:ci` (typecheck + production build).
- Performs a Docker smoke build for `examples/the_wealth_and_health_of_nations/Dockerfile`.

- `.github/workflows/pages.yml`
- Runs on pushes to `main` and on manual dispatch.
- Packs `wealth.dive` and deploys a static demo to GitHub Pages (CDN player + same-origin pack).

- `.github/workflows/release.yml`
- Runs on tags matching `v*.*.*` and on manual dispatch.
- Builds the library (`dist/dive.js`, `dist/dive.iife.js`) and publishes it to npm as `dive-video`.
- Publishes release artifacts (`dist.tar.gz`, `dist-example.tar.gz`) to GitHub Releases.
- Builds and pushes the example Docker image.

Uses npm trusted publishing (OIDC) from this workflow. No `NPM_TOKEN` secret. The trusted publisher on npm must allow `release.yml` in `AdamRidley/DIVE`.

### Release image registry settings

By default, the release workflow pushes to `ghcr.io`.

To push to a custom/private registry, configure these GitHub repository settings:

- Variables: `DOCKER_REGISTRY`, `DOCKER_IMAGE_REPO` (example: `dive-example` or `myorg/dive-example`, must be lowercase)
- Secrets: `DOCKER_REGISTRY_USERNAME`, `DOCKER_REGISTRY_PASSWORD`

### Triggering a release

Create and push a semantic version tag:

```bash
git tag v1.0.0
git push origin v1.0.0
```
