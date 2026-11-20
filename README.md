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

Listen on `<dive-video>` before it upgrades to observe loading. The bubbling,
composed `dive-story-ready` event carries `{ src }` and fires once after story
initialization and readiness of the initial scene (if there is one).
`dive-load-error` carries `{ src, phase, sceneId, error }`; `phase` is `story`
for a source/setup failure (with `sceneId: null`), `scene` for an active
scene failure, including later scenes, or `media` for required packed audio.
The player shows an accessible alert and offers Retry for scene and packed-audio
failures.

Story JSON can include `aspectRatio` (default `9:16`), `audio` (URL or clip objects), and `captions` (WebVTT URL or `{ startTime, endTime, text }` cues). The default height follows available width and the story aspect ratio, adding inset controls and below-video captions, capped at `100dvh`. The picture is contained without cropping at that cap. Explicit CSS `height` overrides automatic sizing and its viewport cap; `width`, `min-height` and `max-height` also remain available. Forced boxes and fullscreen may letterbox.

Set story `"captionsBelow": true`, or add the element's `captions-below` attribute,
to place captions in a fixed-height single-line band beneath the picture.
When caption tracks are available, captions start enabled, preserving the existing
default; the CC button toggles them. Sound remains enabled by default unless the
host sets `muted`.

Scenes may provide a localized `label` for chapter controls, timeline markers,
tooltips, and iframe titles; the scene ID remains the fallback. `settingsLinks`
adds localized resource/download links to the Settings menu. Relative links are
resolved against the story URL and included in `.dive` packs. The menu also offers
viewer layout (Default, Autohide, Inset) and caption location (Overlaid, Below)
choices. These choices do not rewrite story values or host attributes; set
`showUiModeSetting` or `showCaptionLocationSetting` to `false` on the story or in
`configure()` to hide the respective selector.

The timeline shows elapsed/total time without a percentage. Section edges remain
white, internal scene ticks are faded behind labels, and progress is a thin strip
with a playhead. Scrubbing and keyboard seeking do not select control text.
Controls remain visible while keyboard-focused, and drawers support keyboard
focus entry and restoration. Relative story URLs respect the page's
`<base>` element.

Caption placement resolves viewer choice > element `captionsBelow` property >
story `captionsBelow` > overlaid. The element property is `undefined` when no
override is supplied; set it to `false` to override a story's below placement or
`undefined` to follow the story again. Removing a previously set boolean attribute
sets the property to `false`. Story `"languageToggle": "menu"` likewise removes
the need for a host `language-toggle="menu"` attribute.

Playback and seeking do not write time or scene parameters into the host page's
URL. Incoming `t` / `scene` deep links are still read and preserved; language
selection may update `lang` without changing unrelated query parameters.

Set story `"showPlayLabel": true` to show the localized Play/Pause text for that
story without host CSS. Explicit `false` hides it; omission preserves the existing
`--dive-play-button-label-display` theme control and icon-only player default.

Use `<dive-video src="./story.json" muted></dive-video>` to start with sound off; the speaker control enables it on demand. The `isMuted` property also supports programmatic changes without reflecting runtime mute state into the host attribute. Player controls have built-in English and Welsh text; other languages (or rewording) come from `playerText` (see below). `dive-language-change` emits `{ lang }` in its event detail when the active language changes.

Host attributes and inline CSS are author inputs, not storage for calculated state.
During playback in autohide mode, controls hide immediately when the mouse leaves
the player and reappear on entry. The existing inactivity timer still applies while
hovering. Paused playback, open drawers and keyboard focus keep controls visible;
touch interaction retains its existing timeout.
Changing `ui-mode`, `language-toggle`, `captions-below`, or CSS sizing remains effective
through playback. An explicit `ui-mode` overrides scene/story defaults; removing it
restores scene > story > configured defaults. Resolved layout is internal, exposed
only for CSS through `dive-video:state(inset)` (replacing the generated
`active-ui-mode` attribute) and `dive-video:state(captions-below)`.
Automatic height lives in the shadow stylesheet rather than generated host styles.

### Interaction, languages, and theming

- `pauseOnInteract` (boolean) can be set on the story, a scene, or a keyframe `state`. The most specific value wins. When true, tapping a playing tool pauses it (autohide's first tap still just reveals the chrome) and so does an iframe `DIVE_INTERACT`. Interaction never resumes playback.
- `languageToggle` on the story (or the `language-toggle` attribute) places the language picker: `menu` (settings cog, default), `inline` (EN/CY pill in the chrome), `auto` (inline for exactly two languages, menu otherwise), or `none`.
- The inline picker is a joined pill with a sliding accent-coloured underline.
  Codes are shown by default; `--dive-language-name-display: inline` and
  `--dive-language-code-display: none` switch to full names.
- `configure({ language: 'cy' })` sets the initial locale after explicit URL
  `lang` and before saved/browser preferences. Unsupported locales fall back
  to existing preferences; with no configured locale public behavior is unchanged.
- `playerText` sets player UI strings per language, e.g. `{ "fr": { "play": "Lire", "pause": "Pause" } }`. Keys: `loadingStory`, `loadingScene`, `end`, `replay`, `sceneError`, `retry`, `chapters`, `language`, `settings`, `play`, `pause`, `mute`, `unmute`, `hideCaptions`, `showCaptions`, `fullscreen`, `captions`, `audioDescription`, `data`, `dataView`, `dataLoading`. Missing keys fall back to English. Story `playerText` beats `configure({ playerText })`, which beats the built-in text.
- `configure({ showUiModeSetting: false, showCaptionLocationSetting: false })` hides the corresponding viewer preference controls. Story settings override configured values.
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

The public play button remains compact and icon-only. A labelled button is opt-in
styling, with a localized visible Play/Pause label and the same accessible name:

```js
configure({
  theme: {
    '--dive-play-button-label-display': 'inline',
    '--dive-play-button-min-width': '120px',
    '--dive-play-button-height': '48px',
    '--dive-play-button-padding': '10px 16px',
    '--dive-play-button-gap': '10px',
    '--dive-play-button-border': '0',
    '--dive-play-button-radius': '8px',
    '--dive-play-button-bg': 'rgba(255, 255, 255, 0.08)',
    '--dive-play-button-hover-bg': 'rgba(255, 255, 255, 0.16)',
    '--dive-play-button-font-size': '18px',
    '--dive-play-button-font-weight': '700',
  },
});
```

These variables also work in page CSS, which wins over configured defaults.
`--dive-play-button-order` and `--dive-time-display-order` optionally change visual
ordering (both default to `0`). The `play-button` and `time-display` CSS parts remain
available. `--dive-progress-color` overrides the timeline played-strip colour,
falling back to `--dive-progress` and then the accent.

Adapters receive the active keyframe state on mounting, including direct entry
or seeking into a scene. Tool-owned deterministic interpolation/animations still
belong in each tool, not in the sequencer.

## Local development

```bash
npm ci
npm run dev
```

- PoC: http://localhost:5173/
- Wealth and Health example: http://localhost:5173/examples/the_wealth_and_health_of_nations/

```bash
npm run test:ci          # typecheck + library build + dist smoke check
npm run test:controls    # browser controls and responsive-layout regressions (requires Playwright Chromium)
npm run test:caption-authoring
npm run build            # ESM + IIFE + typings → dist/
npm run build:example    # example site → dist-example/
```

Install the browser once before running the browser test locally:

```bash
npx playwright install chromium
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
