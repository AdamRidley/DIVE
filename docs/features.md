# DIVE feature list

Status: **proposed** unless marked done. Sign off a round by ID (e.g. “do F3, F7”).

## Done

| ID | Feature |
|----|---------|
| F0a | Story/overlay **audio** synced to the sequencer (play/pause/seek/mute) |
| F0b | **Captions/subtitles** from WebVTT or inline cues, with CC toggle + `aria-live` |
| F0c | Default **9:16**; story `aspectRatio` overrides (`16:9`, `16/9`, `4:3`, …) |
| F0d | **Letterbox/pillarbox** inside an explicit box or fullscreen |
| F0e | **Autosize** `<dive-video>` from width + aspect unless height is set or fullscreen |
| F1 | **Chapter / scene list** drawer (hamburger on the control bar) |
| F2 | Keyboard: Space/K, J/L or arrows (±5s), F, M, C, Home/End, Esc |
| F4 | End screen with **Replay** |
| F5 | Deep-link `?t=` / `?scene=` / `?lang=` / `#scene-id`; URL stays in sync |
| F6 | Pause + spinner if the current packed scene is not ready |
| F7 | Prefetch next scene (Range for `.dive`, `<link rel=prefetch>` for folder tools) |
| F8/F9 | **`.dive` ordered ZIP** + prefix play + Range-skip via `dive.json` |
| F10 | JSON Schema + `npm run validate:story` |
| F11 | Story `languages`, settings cog, one locale for UI/captions/VO, `DIVE_LANG` |
| F13 | Audio description toggle (`role` / caption `kind: descriptions`) |
| F16 | Fade on tool switch |
| F18 | Poster until first play |
| F19 | CSS parts: `canvas`, `poster`, `overlays`, `overlay`, `captions`, `controls`, `scrubber`, `buffer`, `chapters`, `settings`, `end-screen` |

## Proposed later

### Playback

| ID | Feature | Why |
|----|---------|-----|
| F3 | Playback rate (0.5–2×) with audio pitch-preserve if possible | Review / accessibility |

### Narrative media

| ID | Feature | Why |
|----|---------|-----|
| F12 | Separate music vs voice volumes; ducking | One mute is blunt |
| F14 | Transcript panel (searchable, click-to-seek) | Complements captions |
| F15 | Sequencer **keyframe interpolation** (spec Option 2) | Adapters tween today; cross-adapter motion is stepped |

### Presentation

| ID | Feature | Why |
|----|---------|-----|
| F17 | Safe-area / notch padding for 9:16 | Mobile overlay + captions |
| F20 | Reduced-motion: skip adapter tweens | `prefers-reduced-motion` |

### Authoring / distribution

| ID | Feature | Why |
|----|---------|-----|
| F21 | Record UI (spec §7) to capture keyframes | Still “undecided” in the spec |
| F22 | MP4 prerender + live-tool handoff (spec) | Battery / low-end |
| F23 | React / Vue wrappers | Raw custom element is enough for HTML |
