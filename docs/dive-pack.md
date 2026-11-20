# `.dive` packs

A `.dive` file is an **ordered ZIP** (deflate). `unzip wealth.dive` works. Brotli/zstd belong on HTTP `Content-Encoding`, not inside the file.

## Layout

New packs use manifest **version 2**. Members are written in this order:

1. `dive.json` — tiny TOC (first zip entry, not a custom header)
2. `story.json`
3. Non-audio shared dependencies: captions/VTT, poster, local `settingsLinks` resources (all languages), shared assets/scripts
4. First scene's non-audio tool, data, overlays and dependencies
5. Audio entries, including soundtrack and all narration languages
6. Remaining scenes' non-audio files, in timeline order

This places the first scene before large audio files even on a sequential-only host.
Audio remains compressed: each audio entry must finish downloading and inflating
before it can play. Uncompressed, seekable audio streaming is a future feature.

Absolute `http(s):` and `data:` refs stay outside the pack.
Settings links support relative resources and HTTP(S) URLs, not `data:` URLs.
Packed links are rewritten to blob URLs and retain their authored download filenames.

## Pack

From the repo root:

```bash
npm run pack:dive -- public/story.json -o public/story.dive
npm run pack:dive -- examples/the_wealth_and_health_of_nations/story.json -o dist-example/wealth.dive
```

For an older player, add `--format 1`. Version 2 requires a player that supports
the per-file index described below; existing version 1 packs still work.

Missing local files are skipped with a warning. Remote CDN imports (e.g. D3 on jsDelivr) are left as-is.

## Play

```html
<dive-video src="./story.dive"></dive-video>
```

The player does **not** download the whole file first.

1. `Range` the first bytes to read `dive.json`
2. Read `story.json` using its indexed range
3. Fetch non-audio shared dependencies and the requested scene's individual files;
   `?scene=phase-3` or `?t=...` can skip other scenes and all audio
4. Show the ready tool immediately. Fetch audio active at the current time in the
   selected language (plus music); hold playback/clock until it is available.
   A small audio-loading indicator leaves the visualization visible. Language
   changes and seeks request newly needed audio immediately.
5. Backfill all other files, then other-language narration last, even if never selected.
   Up to four distinct ranges are fetched concurrently within each priority phase;
   identical concurrent range requests share one download. Media failures emit
   `dive-load-error` with `phase: "media"` and offer Retry.
6. Mount and initialize the next scene in a hidden, full-size container while the
   current scene plays. Its data, scripts and `DIVE_READY` handshake complete before
   it is shown. The same iframe is revealed at the transition, without reloading it.

Only the active scene and the next scene stay mounted. Seeking discards obsolete
preloads, and late loads cannot replace the newly selected scene. If a scene is
not ready, the story clock and audio wait together. A page that loads but never sends
`DIVE_READY` is shown after 8 seconds with a console warning; a page that does not load
is reported with a retry action.

Preloading is a full mount, not a prefetch: the next tool's scripts run while it is
hidden, and only CSS animations are paused. Tools with video, WebGL loops or heavy
timers should start them on `DIVE_PLAYBACK` or once visible, not on load.
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
  "version": 2,
  "story": "story.json",
  "defaultLanguage": "en",
  "languages": ["en", "cy"],
  "shared": ["voice-en.mp3", "captions-en.vtt"],
  "files": {
    "story.json": { "offset": 4135, "length": 700 },
    "captions-en.vtt": { "offset": 4835, "length": 200 },
    "tools/a.html": { "offset": 5035, "length": 84000 },
    "voice-en.mp3": { "offset": 89035, "length": 3000000, "audio": true }
  },
  "scenes": [
    { "id": "phase-1", "files": ["tools/a.html"], "offset": 5035, "length": 84000 }
  ]
}
```

`files` indexes every payload entry, including `story.json` and shared assets;
`dive.json` itself is read from the first ZIP local header. Offsets are absolute,
and lengths include the ZIP local header, filename/extra fields and compressed
payload, not central directory records. Ranges do not overlap.
`audio: true` excludes an entry from visual startup. Scene `files` and `shared`
retain logical ownership, regardless of physical ordering.
The padded `dive.json` entry is limited to 1 MiB for version 2 so readers can
fetch it in one bounded range request; the packer reports an error if a story
exceeds this limit. Version 1 retains its 64 KiB packer limit for older-player
compatibility.

Version 2 uses individual file ranges, not scene aggregate ranges (which may
span intervening entries after audio reordering). `prefixEnd` ends after metadata
and non-audio shared files. Version 1 retains the original contiguous shared-media
prefix and scene-group ranges. On a non-range host, the player consumes one stream
and displays the first scene once its dependencies arrive, without awaiting audio.
