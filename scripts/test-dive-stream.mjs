#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import zlib from 'node:zlib';

const repo = resolve(import.meta.dirname, '..');
const packPath = resolve('/tmp/wealth-stream-test.dive');
execFileSync('node', [resolve(repo, 'scripts/pack-dive.mjs'), resolve(repo, 'examples/the_wealth_and_health_of_nations/story.json'), '-o', packPath], {
  stdio: 'inherit',
});

const zip = await readFile(packPath);
const LOCAL = 0x04034b50;

function readLocalEntries(buf) {
  const completed = [];
  let pending = Buffer.from(buf);
  let cursor = 0;
  while (pending.length >= 30) {
    const sig = pending.readUInt32LE(0);
    if (sig !== LOCAL) {
      break;
    }
    const method = pending.readUInt16LE(8);
    const comp = pending.readUInt32LE(18);
    const nameLen = pending.readUInt16LE(26);
    const extra = pending.readUInt16LE(28);
    const total = 30 + nameLen + extra + comp;
    if (pending.length < total) {
      break;
    }
    const name = pending.subarray(30, 30 + nameLen).toString('utf8');
    completed.push({ name, offset: cursor, length: total, method });
    cursor += total;
    pending = pending.subarray(total);
  }
  return completed;
}

function inflateRaw(buf) {
  return zlib.inflateRawSync(buf);
}

function readDiveJson(buf) {
  const entries = readLocalEntries(buf);
  const dive = entries.find((item) => item.name === 'dive.json');
  if (!dive) {
    throw new Error('missing dive.json');
  }
  const raw = buf.subarray(dive.offset + 30 + 'dive.json'.length, dive.offset + dive.length);
  const payload = dive.method === 0 ? raw : inflateRaw(raw);
  return JSON.parse(payload.toString('utf8'));
}

const all = readLocalEntries(zip);
const names = all.map((item) => item.name);
const firstTool = all.find((item) => item.name === 'tools/lifespan-lines.html');
const laterTool = all.find((item) => item.name === 'tools/population-blocks.html');

if (!firstTool || !laterTool) {
  console.error('expected packed tools', names);
  process.exit(1);
}

if (firstTool.offset >= laterTool.offset) {
  console.error('scene 1 tool should complete before later scene bytes');
  process.exit(1);
}

const manifest = readDiveJson(zip);
if (!manifest.prefixEnd || manifest.prefixEnd > firstTool.offset) {
  console.error('prefixEnd should stop before scene 1 tools', manifest.prefixEnd, firstTool.offset);
  process.exit(1);
}

for (const scene of manifest.scenes) {
  if (scene.length <= 0) {
    continue;
  }
  const sig = zip.readUInt32LE(scene.offset);
  if (sig !== LOCAL) {
    console.error(`scene ${scene.id} offset ${scene.offset} is not a zip local header`);
    process.exit(1);
  }
  const nameLen = zip.readUInt16LE(scene.offset + 26);
  const name = zip.subarray(scene.offset + 30, scene.offset + 30 + nameLen).toString('utf8');
  if (name !== scene.files[0]) {
    console.error(`scene ${scene.id} offset points at ${name}, expected ${scene.files[0]}`);
    process.exit(1);
  }
}

const lastScene = manifest.scenes[manifest.scenes.length - 1];
const skipped = zip.subarray(lastScene.offset, lastScene.offset + lastScene.length);
const skippedNames = readLocalEntries(skipped).map((item) => item.name);
if (!skippedNames.includes('tools/population-blocks.html')) {
  console.error('range slice should contain the last scene tool', skippedNames);
  process.exit(1);
}
if (skippedNames.includes('tools/lifespan-lines.html') || skippedNames.includes('tools/rosling-bubbles.html')) {
  console.error('range slice should skip earlier scene tools', skippedNames);
  process.exit(1);
}

const prefixNames = readLocalEntries(zip.subarray(0, manifest.prefixEnd)).map((item) => item.name);
if (!prefixNames.includes('dive.json') || !prefixNames.includes('story.json')) {
  console.error('prefix should include dive.json and story.json', prefixNames);
  process.exit(1);
}
const sceneToolNames = [
  'tools/lifespan-lines.html',
  'tools/rosling-bubbles.html',
  'tools/population-blocks.html',
];
if (prefixNames.some((name) => sceneToolNames.includes(name))) {
  console.error('prefix should not include scene tools', prefixNames);
  process.exit(1);
}
if (!prefixNames.includes('tools/dive-lang.js')) {
  console.error('prefix should include shared tool helpers', prefixNames);
  process.exit(1);
}

console.log(`scene 1 ready after ${firstTool.offset + firstTool.length} / ${zip.length} bytes (${(((firstTool.offset + firstTool.length) / zip.length) * 100).toFixed(1)}%)`);
console.log(`skip to last scene: ${lastScene.length} bytes at ${lastScene.offset} (skipped ${lastScene.offset - manifest.prefixEnd} scene bytes)`);
console.log('stream prefix + range skip ok');
