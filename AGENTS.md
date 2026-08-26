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

## Conventions

- Adapter pattern is mandatory. Sequencer never talks to D3/Mapbox/etc. directly.
- Built-in tools: register in `toolRegistry` (`map`, `scatterplot`). External tools:
  - `tool` ending `.js` → dynamic `import()` of an `IAdapter` class
  - `tool` ending `.html` or `http(s)://` → `IframeAdapter` + `postMessage`
- Iframe protocol (child → parent: `DIVE_INTERACT`, `DIVE_READY`, `DIVE_LANG`; parent → child: `DIVE_INIT`, `DIVE_STATE`, `DIVE_PLAYBACK`, `DIVE_LANG`). Player buffers until `DIVE_READY`.
- Keyframe `time` is milliseconds from **scene start**, not story start.
- `visualState.streamTime: true` makes the player call `setState` every tick.
- `pauseOnInteract` may be set on the scene or on the current keyframe state.
- Overlay placement is `placement: { anchor | mode: "absolute" }`. Legacy `position` is ignored. Audio overlays may omit `placement`.
- `uiMode` is `autohide` (default: overlay chrome, first tap shows it) or `inset` (chrome outside the picture). Scene `uiMode` overrides the story. Attribute `ui-mode` on `<dive-video>` wins.
- Default frame is **9:16**. Set `aspectRatio` on the story (`16:9`, `16/9`, `4:3`) to override. Host autosizes from width unless an explicit height or `:fullscreen` is set (then letterbox).
- `audio` is a URL, clip object, or array. Overlay `{ "type": "audio", "content": "/vo.mp3" }` is also a clip. Synced on play/pause/seek.
- `captions` is a VTT URL, cue array, or track object(s). CC button toggles; cues also go to `aria-live`.
- `languages` lists codes shown in the settings cog. English is the fallback. One locale drives UI, captions, and VO. Tools get `DIVE_LANG`.
- Keyboard: Space/K play, J/L or arrows ±5s, F fullscreen, M mute, C captions, Home/End, Esc closes drawers.
- CSS parts: `canvas`, `poster`, `overlays`, `overlay`, `captions`, `controls`, `scrubber`, `buffer`, `chapters`, `settings`, `end-screen`.
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
