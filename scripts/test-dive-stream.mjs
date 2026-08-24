#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const repo = resolve(import.meta.dirname, '..');
const packPath = resolve('/tmp/wealth-stream-test.dive');
execFileSync('node', [resolve(repo, 'scripts/pack-dive.mjs'), resolve(repo, 'examples/the_wealth_and_health_of_nations/story.json'), '-o', packPath], {
  stdio: 'inherit',
});

const zip = await readFile(packPath);
const LOCAL = 0x04034b50;

function readEntriesIncrementally(buf, chunkSize) {
  const completed = [];
  let pending = Buffer.alloc(0);
  let fed = 0;
  const push = (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 30) {
      const sig = pending.readUInt32LE(0);
      if (sig !== LOCAL) {
        return;
      }
      const comp = pending.readUInt32LE(18);
      const nameLen = pending.readUInt16LE(26);
      const extra = pending.readUInt16LE(28);
      const total = 30 + nameLen + extra + comp;
      if (pending.length < total) {
        return;
      }
      const name = pending.subarray(30, 30 + nameLen).toString('utf8');
      completed.push({ name, fedAfter: fed });
      pending = pending.subarray(total);
    }
  };

  for (let offset = 0; offset < buf.length; offset += chunkSize) {
    const chunk = buf.subarray(offset, Math.min(buf.length, offset + chunkSize));
    fed += chunk.length;
    push(chunk);
  }
  return completed;
}

const entries = readEntriesIncrementally(zip, 2048);
const names = entries.map((item) => item.name);
const firstTool = entries.find((item) => item.name === 'tools/lifespan-lines.html');
const laterTool = entries.find((item) => item.name === 'tools/population-blocks.html');

if (!firstTool || !laterTool) {
  console.error('expected packed tools', names);
  process.exit(1);
}

if (firstTool.fedAfter >= laterTool.fedAfter) {
  console.error('scene 1 tool should complete before later scene bytes');
  process.exit(1);
}

if (firstTool.fedAfter >= zip.length) {
  console.error('scene 1 required the whole file');
  process.exit(1);
}

console.log(`scene 1 ready after ${firstTool.fedAfter} / ${zip.length} bytes (${((firstTool.fedAfter / zip.length) * 100).toFixed(1)}%)`);
console.log(`later scene arrived at ${laterTool.fedAfter} bytes`);
console.log('stream prefix ok');
