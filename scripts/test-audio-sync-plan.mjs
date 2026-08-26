import assert from 'node:assert/strict';
import { planAudioSync } from '../src/core/audio-sync-plan.ts';

function base(overrides = {}) {
  return {
    now: 10000,
    mediaTime: 15,
    audioTime: 15,
    seeking: false,
    readyState: 4,
    hard: false,
    phase: 'locked',
    lastSeekAt: 0,
    lastAssigned: 15,
    clockMoved: false,
    ...overrides,
  };
}

const hard = planAudioSync(base({ hard: true, mediaTime: 15, audioTime: 10 }));
assert.equal(hard.action, 'seek');
assert.equal(hard.seekTo, 15);
assert.equal(hard.phase, 'seeking');
assert.equal(hard.holdStory, true);
assert.equal(hard.event, 'hard-seek');

const held = planAudioSync(base({
  now: 10020,
  mediaTime: 15,
  audioTime: 15,
  phase: 'seeking',
  lastSeekAt: 10000,
  lastAssigned: 15,
  seeking: true,
}));
assert.equal(held.mode, 'hold');
assert.equal(held.action, 'none');
assert.equal(held.holdStory, true);

const waiting = planAudioSync(base({
  now: 10080,
  mediaTime: 15,
  audioTime: 15,
  phase: 'seeking',
  lastSeekAt: 10000,
  lastAssigned: 15,
  seeking: false,
}));
assert.equal(waiting.action, 'play');
assert.equal(waiting.holdStory, true);
assert.notEqual(waiting.event, 'preroll');
assert.notEqual(waiting.event, 'start-snap');

// First-play rows from dive-audio-sync-1787784393297.json.
// Old planner prerolled, then start-snapped the lead, then resynced in a loop.
let state = {
  now: 725102,
  mediaTime: 15,
  audioTime: 15,
  seeking: true,
  readyState: 4,
  hard: true,
  phase: 'locked',
  lastSeekAt: 0,
  lastAssigned: 0,
  clockMoved: false,
};
const events = [];
const seeks = [];
function step(overrides) {
  state = { ...state, hard: false, ...overrides };
  const plan = planAudioSync(state);
  state.phase = plan.phase;
  state.lastSeekAt = plan.lastSeekAt;
  state.lastAssigned = plan.lastAssigned;
  state.clockMoved = plan.clockMoved;
  if (plan.event) events.push(plan.event);
  if (plan.action === 'seek') seeks.push(plan.seekTo);
  return plan;
}

step({ now: 725102, mediaTime: 15, audioTime: 15, hard: true, seeking: true });
step({ now: 725120, mediaTime: 15.01, audioTime: 15, seeking: false });
step({ now: 725176, mediaTime: 15.068, audioTime: 15, seeking: false });
const lead = step({ now: 725333, mediaTime: 15.227, audioTime: 15.348, seeking: false });
assert.notEqual(lead.event, 'start-snap');
assert.notEqual(lead.action, 'seek');
const moving = step({ now: 725474, mediaTime: 15.369, audioTime: 15.516, seeking: false });
assert.ok(moving.phase === 'seeking' || moving.phase === 'locked');
const locked = step({ now: 725697, mediaTime: 15.585, audioTime: 15.759, clockMoved: true });
assert.equal(locked.phase, 'locked');
assert.equal(locked.holdStory, false);

const stillLocked = step({
  now: 726200,
  mediaTime: 16.1,
  audioTime: 16.2,
  phase: 'locked',
  clockMoved: true,
});
assert.equal(stillLocked.action, 'play');
assert.equal(stillLocked.event, undefined);

const stall = planAudioSync(base({
  now: 20000,
  mediaTime: 20,
  audioTime: 18,
  phase: 'locked',
  lastSeekAt: 10000,
  lastAssigned: 18,
  clockMoved: true,
}));
assert.equal(stall.event, 'drift-seek');
assert.equal(stall.action, 'seek');

assert.equal(seeks.length, 1, `chase seeks: ${seeks.join(',')}`);
assert.deepEqual(events, ['hard-seek']);

console.log('audio-sync-plan: ok');
