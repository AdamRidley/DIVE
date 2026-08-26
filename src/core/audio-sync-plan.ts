export type AudioSyncPhase = 'locked' | 'seeking';
export type AudioSyncMode = 'idle' | 'locked' | 'seek' | 'hold';

/** User/story jump or stalled decoder large enough to hard-seek. */
export const HARD_SEEK_SECONDS = 1.25;
/** Minimum wait after a seek before we trust currentTime. */
export const SEEK_HOLD_MS = 40;
/** Give up waiting for the decoder seek flag. */
export const SEEK_TIMEOUT_MS = 250;
/** Clock has started once currentTime leaves the assigned value. */
export const CLOCK_MOVE_SECONDS = 0.02;
/** Stay waiting for the decoder clock this long, then give up and lock. */
export const START_WAIT_MS = 800;

export interface AudioSyncInput {
  now: number;
  mediaTime: number;
  audioTime: number;
  seeking: boolean;
  readyState: number;
  hard: boolean;
  phase: AudioSyncPhase;
  lastSeekAt: number;
  lastAssigned: number;
  clockMoved: boolean;
}

export interface AudioSyncPlan {
  action: 'none' | 'seek' | 'play';
  seekTo?: number;
  mode: AudioSyncMode;
  phase: AudioSyncPhase;
  lastSeekAt: number;
  lastAssigned: number;
  clockMoved: boolean;
  holdStory: boolean;
  event?: string;
  holdMs: number;
}

function keep(input: AudioSyncInput, overrides: Partial<AudioSyncPlan>): AudioSyncPlan {
  return {
    action: 'none',
    mode: 'hold',
    phase: input.phase,
    lastSeekAt: input.lastSeekAt,
    lastAssigned: input.lastAssigned,
    clockMoved: input.clockMoved,
    holdStory: input.phase === 'seeking',
    holdMs: Math.max(0, SEEK_HOLD_MS - (input.now - input.lastSeekAt)),
    ...overrides,
  };
}

export function planAudioSync(input: AudioSyncInput): AudioSyncPlan {
  const drift = input.audioTime - input.mediaTime;
  const abs = Math.abs(drift);
  const moved = input.clockMoved || Math.abs(input.audioTime - input.lastAssigned) >= CLOCK_MOVE_SECONDS;
  const elapsed = input.now - input.lastSeekAt;

  if (input.hard || (input.phase === 'locked' && abs >= HARD_SEEK_SECONDS)) {
    return keep(input, {
      action: 'seek',
      seekTo: input.mediaTime,
      mode: 'seek',
      phase: 'seeking',
      lastSeekAt: input.now,
      lastAssigned: input.mediaTime,
      clockMoved: false,
      holdStory: true,
      event: input.hard ? 'hard-seek' : 'drift-seek',
      holdMs: SEEK_HOLD_MS,
    });
  }

  if (input.phase === 'seeking') {
    const decoderBusy = input.seeking || elapsed < SEEK_HOLD_MS;
    const timedOut = elapsed >= SEEK_TIMEOUT_MS;
    if (decoderBusy && !timedOut) {
      return keep(input, { mode: 'hold', action: 'none', clockMoved: false, holdStory: true });
    }

    if (!moved && elapsed < START_WAIT_MS) {
      return keep(input, {
        action: 'play',
        mode: 'hold',
        clockMoved: false,
        holdStory: true,
        holdMs: 0,
      });
    }

    return keep(input, {
      action: 'play',
      mode: 'locked',
      phase: 'locked',
      clockMoved: moved,
      holdStory: false,
      holdMs: 0,
    });
  }

  return keep(input, {
    action: 'play',
    mode: 'locked',
    phase: 'locked',
    clockMoved: moved,
    holdStory: false,
    holdMs: 0,
  });
}
