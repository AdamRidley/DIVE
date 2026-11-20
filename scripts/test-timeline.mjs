import assert from 'node:assert/strict';
import { resolveTimeline, timelineAt } from '../src/core/timeline.ts';

const scene = (id, startTime, endTime, label) => ({ id, tool: 't', startTime, endTime, label, keyframes: [], overlays: [] });
const section = (id, startTime, endTime, label) => ({ id, startTime, endTime, label });

// Flat by default: authored sections are the track, exactly as before.
const flatStory = [
  section('a', 0, 10000, 'A'),
  section('b', 10000, 20000, 'B'),
];
const flatScenes = [scene('one', 0, 20000, 'One')];
let model = resolveTimeline(flatScenes, flatStory, false);
assert.equal(model.nested, false);
assert.deepEqual(model.acts.map((act) => act.id), ['a', 'b']);
assert.deepEqual(model.acts[0].children, [], 'The flat track must not grow children');

// Sections finer than scenes: the demo shape, one scene holding several sections.
const demoScenes = [
  scene('act-1', 0, 30000, 'Lifespan lines'),
  scene('act-2', 30000, 75000, 'Income and health bubbles'),
];
const demoSections = [
  section('origins', 0, 10000, 'Origins'),
  section('shock', 10000, 20000, 'Shock Era'),
  section('rise', 20000, 25000, 'Modern Rise'),
  section('hold', 25000, 30000, 'Explore Hold'),
  section('baseline', 30000, 45000, '1950 Baseline'),
];
model = resolveTimeline(demoScenes, demoSections, true);
assert.equal(model.nested, true);
assert.deepEqual(model.acts.map((act) => act.id), ['act-1', 'act-2'], 'Scenes become the acts');
assert.deepEqual(model.acts[0].children.map((child) => child.id), ['origins', 'shock', 'rise', 'hold']);
assert.deepEqual(model.acts[1].children.map((child) => child.id), ['baseline']);
assert.equal(model.acts[0].label, 'Lifespan lines');

// Scenes finer than sections: the upstream shape, an act holding several scenes.
const actScenes = [
  scene('s1', 0, 8000, 'First scene'),
  scene('s2', 8000, 20000, 'Second scene'),
  scene('s3', 20000, 30000, 'Third scene'),
];
const actSections = [section('act-1', 0, 20000, 'Act one'), section('act-2', 20000, 30000, 'Act two')];
model = resolveTimeline(actScenes, actSections, true);
assert.equal(model.nested, true);
assert.deepEqual(model.acts.map((act) => act.id), ['act-1', 'act-2'], 'Sections become the acts');
assert.deepEqual(model.acts[0].children.map((child) => child.id), ['s1', 's2']);
assert.deepEqual(model.acts[1].children.map((child) => child.id), ['s3']);

// A section straddling an act edge is clamped to the act it overlaps most.
const straddle = resolveTimeline(
  [scene('left', 0, 10000), scene('right', 10000, 20000)],
  [section('wide', 5000, 15000), section('narrow', 15500, 16000), section('early', 1000, 2000)],
  true,
);
assert.equal(straddle.nested, true);
assert.deepEqual(straddle.acts[0].children.map((child) => [child.id, child.startTime, child.endTime]),
  [['early', 1000, 2000], ['wide', 5000, 10000]],
  'Straddling items are clamped, and an even split goes to the earlier act');
assert.deepEqual(straddle.acts[1].children.map((child) => [child.id, child.startTime, child.endTime]),
  [['narrow', 15500, 16000]]);

// Equal counts nest nothing, so the flat track is used rather than inventing a hierarchy.
const equal = resolveTimeline([scene('one', 0, 10000)], [section('a', 0, 10000)], true);
assert.equal(equal.nested, false);
assert.equal(equal.acts.length, 1);

// No authored sections at all: one act per scene, nested flag stays off.
const noSections = resolveTimeline(demoScenes, [], true);
assert.equal(noSections.nested, false);
assert.deepEqual(noSections.acts.map((act) => act.id), ['act-1', 'act-2']);
assert.equal(noSections.acts[0].label, 'Lifespan lines', 'Scene labels carry through to the acts');

// Lookup used by hover and by the tooltip.
const at = timelineAt(model, 12000);
assert.equal(at.act.id, 'act-1');
assert.equal(at.child.id, 's2');
const beyond = timelineAt(model, 30000);
assert.equal(beyond.act.id, 'act-2', 'The end of the track belongs to the last act');
assert.equal(beyond.child.id, 's3');

// Invalid spans are dropped rather than rendered as zero-width bands.
const dirty = resolveTimeline(
  [scene('ok', 0, 10000), { id: 'bad', tool: 't', startTime: 5000, endTime: 5000, keyframes: [], overlays: [] }],
  [section('fine', 0, 10000), section('broken', 2000, 1000)],
  true,
);
assert.deepEqual(dirty.acts.map((act) => act.id), ['fine'],
  'Dropping the invalid entries leaves equal counts, so the flat section track is used');
assert.equal(dirty.nested, false);
assert.deepEqual(dirty.acts[0].children, []);

console.log('timeline: flat, both nesting orientations, clamping, and lookups passed');
