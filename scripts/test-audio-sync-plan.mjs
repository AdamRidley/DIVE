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

const running = planAudioSync(base({
  now: 10350,
  mediaTime: 42.35,
  audioTime: 42.33,
  phase: 'starting',
  lastSeekAt: 10080,
  lastAssigned: 42.28,
  paused: false,
  clockMoved: true,
}));
assert.equal(running.phase, 'locked');
assert.equal(running.mode, 'locked');
assert.notEqual(running.action, 'slew');

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
  audioTime: 49.7,
  phase: 'locked',
  paused: false,
  lastSeekAt: 10000,
}));
assert.equal(late.event, 'locked-resync');
assert.equal(late.action, 'seek');
assert.equal(late.phase, 'seeking');

console.log('audio-sync-plan: ok');
