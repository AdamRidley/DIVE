# `.dive` packs

A `.dive` file is an **ordered ZIP** (deflate). `unzip wealth.dive` works. Brotli/zstd belong on HTTP `Content-Encoding`, not inside the file.

## Layout

Members are written in this order:

1. `dive.json` — tiny TOC (first zip entry, not a custom header)
2. `story.json`
3. Video-wide media: soundtrack, captions/VTT, poster, story `assets` / `dependencies`
4. Each scene’s tool, data, overlay media, and `dependencies`, in timeline order

Absolute `http(s):` and `data:` refs stay outside the pack.

## Pack

From the repo root:

```bash
npm run pack:dive -- public/story.json -o public/story.dive
npm run pack:dive -- examples/the_wealth_and_health_of_nations/story.json -o dist-example/wealth.dive
```

Missing local files are skipped with a warning. Remote CDN imports (e.g. D3 on jsDelivr) are left as-is.

## Play

```html
<dive-video src="./story.dive"></dive-video>
```

The player does **not** download the whole file first.

1. `Range` the first bytes to read `dive.json`
2. `Range` `[0, prefixEnd)` for `story.json` + video-wide audio/captions/data
3. `Range` the current scene’s `offset`/`length` — so `?scene=phase-3` (or a seek to that scene) can skip scenes 1–2
4. Backfill skipped scenes in the background
5. Mount and initialize the next scene in a hidden, full-size container while the
   current scene plays. Its data, scripts and `DIVE_READY` handshake complete before
   it is shown. The same iframe is revealed at the transition, without reloading it.

Only the active scene and the next scene stay mounted. Seeking discards obsolete
preloads, and late loads cannot replace the newly selected scene. If a scene is
not ready, the story clock and audio wait together. A page that loads but never sends
`DIVE_READY` is shown after 8 seconds with a console warning; a page that does not load
is reported with a retry action.

If the host ignores `Range` (HTTP 200), it falls back to a sequential stream. Same-origin Vite and most CDNs (jsDelivr, unpkg) support byte ranges. Cross-origin hosts must allow the `Range` header.

```html
<dive-video src="./wealth.dive"></dive-video>
<!-- start on scene 3 without pulling scene 1–2 tools first -->
<!-- page URL: ?scene=phase-3-population-blocks  or  #phase-3-population-blocks -->
```

HTML tools get a small fetch/`URL` shim so relative loads like `../data/foo.json` resolve inside the pack. External absolute URLs are unchanged.
Bare local references such as `src="dive-lang.js"` and dependencies of nested pages
are also packed and rewritten. Materialized pages are reused until more pack files
arrive, at which point their dependency maps are refreshed.

## `dive.json`

```json
{
  "version": 1,
  "story": "story.json",
  "defaultLanguage": "en",
  "languages": ["en", "cy"],
  "shared": ["voice-en.mp3", "captions-en.vtt"],
  "scenes": [
    { "id": "phase-1", "files": ["tools/a.html"], "offset": 1200, "length": 84000 }
  ]
}
```

`offset` / `length` are byte ranges in the `.dive` file. The player uses them for HTTP `Range` so a seek or `?scene=` can skip earlier scene tools. Video-wide media in `shared` still comes first — that is required for any start language.
