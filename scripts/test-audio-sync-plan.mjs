import assert from 'node:assert/strict';
import { planAudioSync } from '../src/core/audio-sync-plan.ts';

function base(overrides = {}) {
  return {
    now: 10000,
    mediaTime: 42,
    audioTime: 42,
    seeking: false,
    readyState: 4,
    hard: false,
    phase: 'locked',
    lastSeekAt: 0,
    lastAssigned: 42,
    catchUpArmed: false,
    clockMoved: false,
    correcting: false,
    rate: 1,
    ...overrides,
  };
}

// Replay: play/scrub assigns currentTime, story runs, audio clock frozen.
const hard = planAudioSync(base({ hard: true, mediaTime: 42, audioTime: 10 }));
assert.equal(hard.action, 'seek');
assert.equal(hard.seekTo, 42);
assert.equal(hard.phase, 'settling');
assert.equal(hard.catchUpArmed, true);
assert.equal(hard.event, 'hard-seek');

// During hold the story is 80ms ahead and audio is still at the assigned value.
const held = planAudioSync(base({
  now: 10050,
  mediaTime: 42.05,
  audioTime: 42,
  phase: 'settling',
  lastSeekAt: 10000,
  lastAssigned: 42,
  catchUpArmed: true,
  seeking: true,
}));
assert.equal(held.mode, 'hold');
assert.equal(held.action, 'none');

// After the decoder clock finally moves, audio is ~200ms late — snap, don't rate-crawl.
const late = planAudioSync(base({
  now: 10200,
  mediaTime: 42.2,
  audioTime: 42.02,
  phase: 'settling',
  lastSeekAt: 10000,
  lastAssigned: 42,
  catchUpArmed: true,
  seeking: false,
  readyState: 4,
}));
assert.equal(late.event, 'catchup');
assert.equal(late.action, 'seek');
assert.equal(late.seekTo, 42.2);
assert.equal(late.catchUpArmed, false);

// After the one catch-up, lock instead of entering 1%/s correction.
const after = planAudioSync(base({
  now: 10300,
  mediaTime: 42.3,
  audioTime: 42.28,
  phase: 'settling',
  lastSeekAt: 10200,
  lastAssigned: 42.2,
  catchUpArmed: false,
  clockMoved: true,
  seeking: false,
}));
assert.equal(after.phase, 'locked');
assert.equal(after.mode, 'locked');
assert.equal(after.action, 'none');

// 40ms wander stays locked — this was the flicker in the previous log.
const wander = planAudioSync(base({
  mediaTime: 50,
  audioTime: 49.96,
  phase: 'locked',
}));
assert.equal(wander.mode, 'locked');
assert.equal(wander.correcting, false);

// Genuine 250ms drift during play may rate-correct, but a scrub must not.
const drift = planAudioSync(base({
  mediaTime: 50,
  audioTime: 49.7,
  phase: 'locked',
}));
assert.equal(drift.mode, 'rate');
assert.equal(drift.action, 'slew');

console.log('audio-sync-plan: ok');
