# DIVE

Interruptible Narrative Visualization framework. A Lit web component (`<dive-video>`) plays a JSON story against pluggable visualization adapters. Pause = explore the live tool; play = snap back to the sequencer’s virtual state.

This is a library + demo monorepo, not an app server. Do not treat `examples/` as the package.

## Stack

- TypeScript 5, Vite 8, Lit 3, D3 7
- Custom element: `dive-video` (Shadow DOM)
- Node 22 in CI and locally
- Install: `npm ci` (lockfile is required in CI)

```bash
npm ci
npm run dev                 # PoC at http://localhost:5173/  (index.html + public/story.json)
npm run typecheck           # tsc --noEmit
npm run build               # library bundles + .d.ts → dist/
npm run check:dist          # smoke-check published files exist
npm run test:ci             # typecheck + validate stories + build + check:dist
npm run build:example       # Wealth and Health demo → dist-example/
npm run pack:dive -- path/to/story.json -o story.dive
npm run build:pages          # dist-pages/ for GitHub Pages (CDN player + wealth.dive)
# <dive-video src="./story.dive"></dive-video>  — see docs/dive-pack.md

```

Example (separate from the npm package):

```bash
npm run dev
# http://localhost:5173/examples/the_wealth_and_health_of_nations/
npm run build:wealth-health-data   # regenerate Gapminder JSON from raw CSVs
```

## Layout

- `src/index.ts` — public library entry (side-effect registers `<dive-video>`)
- `src/main.ts` — demo entry (`index.html` only)
- `src/components/dive-video.ts` — player UI, story loader, tool registry, overlays
- `src/core/Sequencer.ts` — rAF clock, scene lookup, keyframe snapshot (no interpolation yet)
- `src/core/Adapter.ts` — `IAdapter` contract
- `src/core/types.ts` — `Story` / `Scene` / `Keyframe` / `Overlay` types
- `src/core/aspect.ts`, `src/core/audio.ts`, `src/core/captions.ts` — frame, soundtrack, VTT
- `docs/features.md` — signed-off feature backlog
- `docs/dive-pack.md` — `.dive` ordered-zip layout and packer
- `src/adapters/` — built-in `map`, `scatterplot`, plus `IframeAdapter`
- `public/` — PoC story + iframe/JS tool fixtures
- `examples/the_wealth_and_health_of_nations/` — Gapminder demo (iframe tools, Docker)
- `.github/workflows/ci.yml` — PR/`main`: `npm run test:ci` + example Docker smoke
- `.github/workflows/release.yml` — tag `v*.*.*`: GitHub Release tarballs, npm publish, example image
- `.github/workflows/pages.yml` — `main`: GitHub Pages demo (jsDelivr `dive-video` + `wealth.dive`)

## Conventions

- Adapter pattern is mandatory. Sequencer never talks to D3/Mapbox/etc. directly.
- Built-in tools: register in `toolRegistry` (`map`, `scatterplot`). External tools:
  - `tool` ending `.js` → dynamic `import()` of an `IAdapter` class
  - `tool` ending `.html` or `http(s)://` → `IframeAdapter` + `postMessage`
- Iframe protocol (child → parent: `DIVE_INTERACT`, `DIVE_READY`, `DIVE_LANG`, `DIVE_NAVIGATE { sceneId, play? }`; parent → child: `DIVE_INIT`, `DIVE_STATE`, `DIVE_PLAYBACK`, `DIVE_LANG`). Player buffers until `DIVE_READY`; a loaded page with no `DIVE_READY` is shown after 8s with a warning, and a page that never loads gets an error with Retry.
- Keyframe `time` is milliseconds from **scene start**, not story start.
- `visualState.streamTime: true` makes the player call `setState` every tick.
- `pauseOnInteract` resolves keyframe `state` > scene > story > `configure()` default > `false`. When true, a tap on the playing stage (after autohide's reveal tap) or `DIVE_INTERACT` pauses. Interaction never resumes.
- Overlay placement is `placement: { anchor | mode: "absolute" }`. Legacy `position` is ignored. Audio overlays may omit `placement`.
- `uiMode` is `autohide` (default: overlay chrome, first tap shows it) or `inset` (chrome outside the picture). Scene `uiMode` overrides the story. Attribute `ui-mode` on `<dive-video>` wins.
- Default frame is **9:16**. Set `aspectRatio` on the story (`16:9`, `16/9`, `4:3`) to override. Host autosizes from width unless an explicit height or `:fullscreen` is set (then letterbox).
- `audio` is a URL, clip object, or array. Overlay `{ "type": "audio", "content": "/vo.mp3" }` is also a clip. Synced on play/pause/seek.
- `captions` is a VTT URL, cue array, or track object(s). CC button toggles; cues also go to `aria-live`.
- `languages` lists the locales. English is the fallback. One locale drives UI, captions, and VO. Tools get `DIVE_LANG`. `languageToggle` (`menu` default, `inline`, `auto`, `none`; attribute `language-toggle` wins) decides whether the picker is in the settings cog or an inline pill.
- Theming is CSS custom properties (`--dive-accent`, `--dive-accent-contrast`, `--dive-font`, `--dive-chrome-bg`, `--dive-chrome-fg`, `--dive-stage-bg`, `--dive-scrubber-bg`, `--dive-progress`, `--dive-drawer-bg`, `--dive-button-bg`, `--dive-button-hover-bg`). Keep built-in values neutral; brands set them from page CSS or `configure({ theme })`.
- `configure()` / `DiveVideo.configure()` sets page-wide defaults (`uiMode`, `languages`, `languageToggle`, `pauseOnInteract`, `theme`, `playerText`). Story values and page CSS always win.
- Player UI strings: built-in `en` and `cy` in `src/core/locale.ts`; other languages via `playerText` (story > `configure()` > built-in > English). Don't hard-code new languages into the player.
- Keyboard: Space/K play, J/L or arrows ±5s, F fullscreen, M mute, C captions, Home/End, Esc closes drawers.
- CSS parts: `canvas`, `poster`, `overlays`, `overlay`, `captions`, `controls`, `scrubber`, `buffer`, `chapters`, `settings`, `lang-toggle`, `end-screen`.
- Feature backlog: `docs/features.md`.
- Workshop-first for product behaviour. Packaging/CI changes that the user asked for are in-scope.

## Publishing / CDN

Package name on npm is `dive-video` (`dive` is taken). CDN after publish:

```html
<script type="module" src="https://cdn.jsdelivr.net/npm/dive-video@1.0.0/dist/dive.js"></script>
<dive-video src="./story.json"></dive-video>
```

Classic script: `dist/dive.iife.js` (global `DIVE`).

Release path (already in Actions — do not invent a parallel one):

1. `npm version` / bump `package.json`
2. `git tag vX.Y.Z && git push origin vX.Y.Z`
3. `release.yml` builds, attaches `dist.tar.gz` + `dist-example.tar.gz`, `npm publish`, pushes the example image

Requires npm trusted publishing on `dive-video` for GitHub Actions workflow `release.yml` in `AdamRidley/DIVE` (OIDC, no `NPM_TOKEN`).

Public demo: https://adamridley.github.io/DIVE/ — Pages site from `pages.yml`. Player is the published CDN build (`package.json` version); the story pack is rebuilt from `examples/the_wealth_and_health_of_nations/` on each `main` push. Do not bundle `dist/dive.js` into Pages.

## Pitfalls

- `npm run build` is the **library**, not the PoC SPA. Demo is `npm run dev` or `build:example`.
- Built-in D3 adapters are bundled into the CDN file (large). Example tools load D3 themselves from jsDelivr.
- Dynamic `.js` tools resolve against `window.location.origin`, not the npm package URL.
- Sequencer does not interpolate keyframes; it snapshots the last keyframe ≤ scene time. Adapters tween.
- `public/story.json` overlay `position` is stale; real stories must use `placement`.
- Docker example **must** be built from repo root (`-f examples/.../Dockerfile .`).
- `package.json` `license` is MIT (matches `LICENSE`). Do not revert to ISC.
- Do not publish `examples/` or Gapminder raw data on npm (`files` allowlist).

## Verify

Done means all of:

```bash
npm run test:ci
```

- `dist/dive.js`, `dist/dive.iife.js`, `dist/dive.js.map`, `dist/index.d.ts` exist
- `dist/dive.js` contains the string `dive-video`
- `npm pack --dry-run` lists only `dist/*`, README, LICENSE, spec
- After a real publish: `curl -sI https://cdn.jsdelivr.net/npm/dive-video@<ver>/dist/dive.js` → 200
