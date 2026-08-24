# DIVE feature list

Status: **proposed** unless marked done. Sign off a round by ID (e.g. “do F3, F7”).

## Done this round

| ID | Feature |
|----|---------|
| F0a | Story/overlay **audio** synced to the sequencer (play/pause/seek/mute) |
| F0b | **Captions/subtitles** from WebVTT or inline cues, with CC toggle + `aria-live` |
| F0c | Default **9:16**; story `aspectRatio` overrides (`16:9`, `16/9`, `4:3`, …) |
| F0d | **Letterbox/pillarbox** inside an explicit box or fullscreen |
| F0e | **Autosize** `<dive-video>` from width + aspect unless height is set or fullscreen |
| F8/F9 | **`.dive` ordered ZIP**: `dive.json` + `story.json` + video-wide audio/captions + scenes. `npm run pack:dive`. Still unzip-compatible. |
| F10 | JSON Schema + `npm run validate:story` |

## Proposed next rounds

### Playback & navigation

| ID | Feature | Why |
|----|---------|-----|
| F1 | **Chapter / scene list** (drawer or end-card) to jump to a scene/tool | Scrubber bands exist; no named navigator |
| F2 | Keyboard: Space, J/L or arrows, F, M, C, Home/End | Expected of a “video” |
| F3 | Playback rate (0.5–2×) with audio pitch-preserve if possible | Review / accessibility |
| F4 | Loop / end screen (replay, next story) | Stories currently freeze on last frame |
| F5 | Deep-link `?t=12000` / `#scene-id` | Share a moment |

### Loading / packaging

| ID | Feature | Why |
|----|---------|-----|
| F6 | **Preload / buffer scenes** ahead; pause + spinner if the current tool/data is not ready so time does not skip | Scene switches can flash or miss keyframes |
| F7 | Prefetch next tool iframe/module + data during the previous scene | Makes F6 actually seamless |

### Narrative media

| ID | Feature | Why |
|----|---------|-----|
| F11 | Multiple caption languages + track picker | F0b is one active set |
| F12 | Separate music vs voice volumes; ducking | One mute is blunt |
| F13 | Spoken description track (`kind: descriptions`) | A11y beyond captions |
| F14 | Transcript panel (searchable, click-to-seek) | Complements captions |
| F15 | Sequencer **keyframe interpolation** (spec Option 2) | Adapters tween today; cross-adapter motion is stepped |

### Presentation

| ID | Feature | Why |
|----|---------|-----|
| F16 | Cross-tool visual transitions (fade/slide) | Hard cuts on `switchTool` |
| F17 | Safe-area / notch padding for 9:16 | Mobile overlay + captions |
| F18 | Poster / first-frame thumbnail before play | Blank canvas until seek(0) mounts |
| F19 | Theming via CSS parts (`::part(controls)`, captions) | Shadow DOM blocks host CSS |
| F20 | Reduced-motion: skip adapter tweens | `prefers-reduced-motion` |

### Authoring / distribution

| ID | Feature | Why |
|----|---------|-----|
| F21 | Record UI (spec §7) to capture keyframes | Still “undecided” in the spec |
| F22 | MP4 prerender + live-tool handoff (spec) | Battery / low-end |
| F23 | React / Vue wrappers | Raw custom element is enough for HTML |

## Packaging note (F8 / F9)

Prefer a **prefix-playable** format over a naive zip if the goal is “start scene 1 as soon as its bytes exist”:

1. Header (magic, story JSON length, index of scenes)
2. `story.json`
3. Scene 1 tool + data + audio/captions it needs
4. Scene 2 … in timeline order

A zip is simpler to author (`dive pack`) but needs the central directory at the end, so the player must wait or we generate a sidecar index. Could do **zip for authors** and **`.dive` stream pack for CDN**.

## Suggested next implementation round

**F1 + F6 + F7** — chapter list and scene buffering/spinner. Packaging (F8/F9) after the player can wait on a scene without skipping.
