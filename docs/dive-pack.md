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

The player streams `fetch().body` and walks **local file headers from the front**. Playback can start as soon as `dive.json`, `story.json`, video-wide media, and the first scene’s files have arrived. Later scenes keep downloading; if you seek into one that is not here yet, the clock holds and a spinner shows.

HTML tools get a small fetch/`URL` shim so relative loads like `../data/foo.json` resolve inside the pack. External absolute URLs are unchanged.

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

`offset` / `length` are byte ranges in the `.dive` file (for later HTTP Range). Sequential play does not need them.
