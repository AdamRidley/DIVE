import assert from 'node:assert/strict';
import { DEFAULT_PREROLL_SECONDS, planAudioSync } from '../src/core/audio-sync-plan.ts';

function base(overrides = {}) {
  return {
    now: 10000,
    mediaTime: 42,
    audioTime: 42,
    seeking: false,
    readyState: 4,
    paused: true,
    hard: false,
    phase: 'locked',
    lastSeekAt: 0,
    lastAssigned: 42,
    clockMoved: false,
    preroll: DEFAULT_PREROLL_SECONDS,
    resyncs: 0,
    ...overrides,
  };
}

const hard = planAudioSync(base({ hard: true, mediaTime: 42, audioTime: 10 }));
assert.equal(hard.action, 'seek');
assert.equal(hard.seekTo, 42);
assert.equal(hard.phase, 'seeking');
assert.equal(hard.event, 'hard-seek');

const held = planAudioSync(base({
  now: 10040,
  mediaTime: 42.04,
  audioTime: 42,
  phase: 'seeking',
  lastSeekAt: 10000,
  lastAssigned: 42,
  seeking: true,
}));
assert.equal(held.mode, 'hold');
assert.equal(held.action, 'none');

const preroll = planAudioSync(base({
  now: 10080,
  mediaTime: 42.08,
  audioTime: 42,
  phase: 'seeking',
  lastSeekAt: 10000,
  lastAssigned: 42,
  seeking: false,
  readyState: 4,
}));
assert.equal(preroll.event, 'preroll');
assert.equal(preroll.action, 'seek');
assert.equal(preroll.phase, 'starting');
assert.ok(preroll.seekTo > 42.08);

const starting = planAudioSync(base({
  now: 10100,
  mediaTime: 42.1,
  audioTime: 42.28,
  phase: 'starting',
  lastSeekAt: 10080,
  lastAssigned: 42.28,
  paused: false,
  clockMoved: false,
}));
assert.equal(starting.phase, 'starting');
assert.equal(starting.action, 'play');

// Replay of the first-play lock: clock finally moves 359ms after preroll, 100ms late.
const firstPlay = planAudioSync(base({
  now: 3639674,
  mediaTime: 59.45122,
  audioTime: 59.349496,
  phase: 'starting',
  lastSeekAt: 3639315,
  lastAssigned: 59.29258,
  paused: false,
  clockMoved: false,
  preroll: 0.2,
  resyncs: 0,
}));
assert.equal(firstPlay.event, 'start-snap');
assert.equal(firstPlay.action, 'seek');
assert.equal(firstPlay.phase, 'starting');
assert.ok(firstPlay.seekTo > 59.45122);

// Frozen past 400ms must not lock — that was the first-play miss if lastSeekAt was stale.
const stillFrozen = planAudioSync(base({
  now: 3639620,
  mediaTime: 59.39288,
  audioTime: 59.29258,
  phase: 'starting',
  lastSeekAt: 3639219,
  lastAssigned: 59.29258,
  paused: false,
  clockMoved: false,
  preroll: 0.2,
}));
assert.equal(stillFrozen.phase, 'starting');
assert.equal(stillFrozen.mode, 'start');

const aligned = planAudioSync(base({
  now: 10350,
  mediaTime: 42.35,
  audioTime: 42.345,
  phase: 'starting',
  lastSeekAt: 10080,
  lastAssigned: 42.28,
  paused: false,
  clockMoved: true,
}));
assert.equal(aligned.phase, 'locked');
assert.equal(aligned.mode, 'locked');

const wander = planAudioSync(base({
  mediaTime: 50,
  audioTime: 49.96,
  phase: 'locked',
  paused: false,
  lastSeekAt: 9000,
}));
assert.equal(wander.mode, 'locked');
assert.equal(wander.action, 'play');

const late = planAudioSync(base({
  now: 12000,
  mediaTime: 50,
  audioTime: 49.85,
  phase: 'locked',
  paused: false,
  lastSeekAt: 10000,
}));
assert.equal(late.event, 'locked-resync');
assert.equal(late.action, 'seek');
assert.equal(late.phase, 'seeking');

console.log('audio-sync-plan: ok');
