export type AudioSyncPhase = 'locked' | 'seeking' | 'starting';
export type AudioSyncMode = 'idle' | 'locked' | 'seek' | 'hold' | 'start';

/** User/story jump large enough to hard-seek. */
export const HARD_SEEK_SECONDS = 1.25;
/** Minimum wait after a seek before we trust currentTime. */
export const SEEK_HOLD_MS = 60;
/** Give up waiting for the decoder. */
export const SEEK_TIMEOUT_MS = 250;
/** Clock has started once currentTime leaves the assigned value. */
export const CLOCK_MOVE_SECONDS = 0.015;
/** After the clock is running, snap again if still this far off. */
export const START_SNAP_SECONDS = 0.08;
/** While locked, only resync if drift stays this large. */
export const LOCKED_RESYNC_SECONDS = 0.22;
/** Don't resync again until this long after the last seek. */
export const RESYNC_COOLDOWN_MS = 700;
/** How long the decoder typically sits still after play(). */
export const DEFAULT_PREROLL_SECONDS = 0.2;
export const MIN_PREROLL_SECONDS = 0.08;
export const MAX_PREROLL_SECONDS = 0.35;

export interface AudioSyncInput {
  now: number;
  mediaTime: number;
  audioTime: number;
  seeking: boolean;
  readyState: number;
  paused: boolean;
  hard: boolean;
  phase: AudioSyncPhase;
  lastSeekAt: number;
  lastAssigned: number;
  clockMoved: boolean;
  preroll: number;
  resyncs: number;
}

export interface AudioSyncPlan {
  action: 'none' | 'seek' | 'play';
  seekTo?: number;
  mode: AudioSyncMode;
  phase: AudioSyncPhase;
  lastSeekAt: number;
  lastAssigned: number;
  clockMoved: boolean;
  preroll: number;
  resyncs: number;
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
    preroll: input.preroll,
    resyncs: input.resyncs,
    holdMs: Math.max(0, SEEK_HOLD_MS - (input.now - input.lastSeekAt)),
    ...overrides,
  };
}

function decoderReady(input: AudioSyncInput): boolean {
  const elapsed = input.now - input.lastSeekAt;
  return elapsed >= SEEK_TIMEOUT_MS || (elapsed >= SEEK_HOLD_MS && !input.seeking && input.readyState >= 2);
}

export function planAudioSync(input: AudioSyncInput): AudioSyncPlan {
  const drift = input.audioTime - input.mediaTime;
  const abs = Math.abs(drift);
  const moved = input.clockMoved || Math.abs(input.audioTime - input.lastAssigned) >= CLOCK_MOVE_SECONDS;
  const preroll = Math.max(MIN_PREROLL_SECONDS, Math.min(MAX_PREROLL_SECONDS, input.preroll || DEFAULT_PREROLL_SECONDS));

  if (input.hard || (input.phase === 'locked' && abs >= HARD_SEEK_SECONDS)) {
    return keep(input, {
      action: 'seek',
      seekTo: input.mediaTime,
      mode: 'seek',
      phase: 'seeking',
      lastSeekAt: input.now,
      lastAssigned: input.mediaTime,
      clockMoved: false,
      resyncs: 0,
      event: input.hard ? 'hard-seek' : 'drift-seek',
      holdMs: SEEK_HOLD_MS,
    });
  }

  if (input.phase === 'seeking') {
    if (!decoderReady(input)) {
      return keep(input, { mode: 'hold', clockMoved: moved });
    }
    return keep(input, {
      action: 'seek',
      seekTo: input.mediaTime + preroll,
      mode: 'seek',
      phase: 'starting',
      lastSeekAt: input.now,
      lastAssigned: input.mediaTime + preroll,
      clockMoved: false,
      event: 'preroll',
      holdMs: 0,
    });
  }

  if (input.phase === 'starting') {
    if (!moved && input.now - input.lastSeekAt < 400) {
      return keep(input, { mode: 'start', action: 'play', clockMoved: false, holdMs: 0 });
    }

    if (moved && abs >= START_SNAP_SECONDS && input.resyncs < 1) {
      return keep(input, {
        action: 'seek',
        seekTo: input.mediaTime,
        mode: 'seek',
        phase: 'seeking',
        lastSeekAt: input.now,
        lastAssigned: input.mediaTime,
        clockMoved: false,
        resyncs: input.resyncs + 1,
        event: 'start-snap',
        holdMs: SEEK_HOLD_MS,
      });
    }

    return keep(input, {
      action: 'play',
      mode: 'locked',
      phase: 'locked',
      clockMoved: moved,
      holdMs: 0,
    });
  }

  if (abs >= LOCKED_RESYNC_SECONDS && input.now - input.lastSeekAt >= RESYNC_COOLDOWN_MS) {
    return keep(input, {
      action: 'seek',
      seekTo: input.mediaTime,
      mode: 'seek',
      phase: 'seeking',
      lastSeekAt: input.now,
      lastAssigned: input.mediaTime,
      clockMoved: false,
      resyncs: 0,
      event: 'locked-resync',
      holdMs: SEEK_HOLD_MS,
    });
  }

  return keep(input, {
    action: 'play',
    mode: 'locked',
    phase: 'locked',
    clockMoved: moved,
    holdMs: 0,
  });
}
