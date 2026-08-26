export type AudioSyncPhase = 'locked' | 'settling' | 'rate';
export type AudioSyncMode = 'idle' | 'locked' | 'rate' | 'seek' | 'hold';

/** Start rate-correcting only once drift is clearly worth it. */
export const RATE_ENTER_SECONDS = 0.18;
/** Stop correcting once back inside this band. */
export const RATE_EXIT_SECONDS = 0.08;
/** Drift that maps to the max target-rate offset. */
export const RATE_DRIFT_SPAN_SECONDS = 4;
/** Cap on |target playbackRate - 1|. */
export const MAX_TARGET_RATE_DELTA = 0.12;
/** How fast the applied rate may move toward the target. */
export const MAX_RATE_CHANGE_PER_SECOND = 0.01;
/** Don't poke the decoder for tinier rate writes than this. */
export const RATE_WRITE_EPSILON = 0.001;
/** User/story jump large enough to hard-seek. */
export const HARD_SEEK_SECONDS = 1.25;
/** Minimum wait after a seek before we trust currentTime. */
export const SEEK_HOLD_MS = 80;
/** Give up waiting for the clock and catch up anyway. */
export const SETTLE_TIMEOUT_MS = 250;
/** Treat currentTime as "the clock started" once it leaves the assigned value. */
export const CLOCK_MOVE_SECONDS = 0.02;
/** Snap again after settle if still this far off. */
export const CATCHUP_SECONDS = 0.05;

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
  catchUpArmed: boolean;
  clockMoved: boolean;
  correcting: boolean;
  rate: number;
}

export interface AudioSyncPlan {
  action: 'none' | 'seek' | 'slew';
  seekTo?: number;
  targetRate: number;
  mode: AudioSyncMode;
  phase: AudioSyncPhase;
  lastSeekAt: number;
  lastAssigned: number;
  catchUpArmed: boolean;
  clockMoved: boolean;
  correcting: boolean;
  event?: string;
  holdMs: number;
}

function targetRateForDrift(drift: number): number {
  const adj = Math.max(-MAX_TARGET_RATE_DELTA, Math.min(MAX_TARGET_RATE_DELTA, drift / RATE_DRIFT_SPAN_SECONDS));
  return 1 - adj;
}

export function planAudioSync(input: AudioSyncInput): AudioSyncPlan {
  const drift = input.audioTime - input.mediaTime;
  const abs = Math.abs(drift);
  const holdMs = Math.max(0, SEEK_HOLD_MS - (input.now - input.lastSeekAt));

  if (input.hard || abs >= HARD_SEEK_SECONDS) {
    return {
      action: 'seek',
      seekTo: input.mediaTime,
      targetRate: 1,
      mode: 'seek',
      phase: 'settling',
      lastSeekAt: input.now,
      lastAssigned: input.mediaTime,
      catchUpArmed: true,
      clockMoved: false,
      correcting: false,
      event: input.hard ? 'hard-seek' : 'drift-seek',
      holdMs: SEEK_HOLD_MS,
    };
  }

  const moved = input.clockMoved || Math.abs(input.audioTime - input.lastAssigned) >= CLOCK_MOVE_SECONDS;
  const elapsed = input.now - input.lastSeekAt;
  const decoderReady = !input.seeking && input.readyState >= 2;
  const waited = elapsed >= SEEK_HOLD_MS;
  const timedOut = elapsed >= SETTLE_TIMEOUT_MS;
  const ready = timedOut || (waited && decoderReady);

  if (input.phase === 'settling') {
    if (input.catchUpArmed && ready && abs >= CATCHUP_SECONDS) {
      return {
        action: 'seek',
        seekTo: input.mediaTime,
        targetRate: 1,
        mode: 'seek',
        phase: 'settling',
        lastSeekAt: input.now,
        lastAssigned: input.mediaTime,
        catchUpArmed: false,
        clockMoved: false,
        correcting: false,
        event: 'catchup',
        holdMs: SEEK_HOLD_MS,
      };
    }

    if (ready && (!input.catchUpArmed || abs < CATCHUP_SECONDS)) {
      return {
        action: 'none',
        targetRate: 1,
        mode: 'locked',
        phase: 'locked',
        lastSeekAt: input.lastSeekAt,
        lastAssigned: input.lastAssigned,
        catchUpArmed: false,
        clockMoved: moved,
        correcting: false,
        holdMs: 0,
      };
    }

    return {
      action: 'none',
      targetRate: 1,
      mode: 'hold',
      phase: 'settling',
      lastSeekAt: input.lastSeekAt,
      lastAssigned: input.lastAssigned,
      catchUpArmed: input.catchUpArmed,
      clockMoved: moved,
      correcting: false,
      holdMs,
    };
  }

  let correcting = input.correcting;
  if (!correcting && abs >= RATE_ENTER_SECONDS) {
    correcting = true;
  } else if (correcting && abs <= RATE_EXIT_SECONDS) {
    correcting = false;
  }

  if (correcting) {
    return {
      action: 'slew',
      targetRate: targetRateForDrift(drift),
      mode: 'rate',
      phase: 'rate',
      lastSeekAt: input.lastSeekAt,
      lastAssigned: input.lastAssigned,
      catchUpArmed: false,
      clockMoved: moved,
      correcting: true,
      holdMs: 0,
    };
  }

  const stillSlewing = Math.abs(input.rate - 1) >= RATE_WRITE_EPSILON;
  return {
    action: stillSlewing ? 'slew' : 'none',
    targetRate: 1,
    mode: stillSlewing ? 'rate' : 'locked',
    phase: 'locked',
    lastSeekAt: input.lastSeekAt,
    lastAssigned: input.lastAssigned,
    catchUpArmed: false,
    clockMoved: moved,
    correcting: false,
    holdMs: 0,
  };
}
