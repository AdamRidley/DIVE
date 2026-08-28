#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, 'dist-pages');
const version = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')).version;

await mkdir(outDir, { recursive: true });

const template = await readFile(resolve(root, 'pages/index.html'), 'utf8');
await writeFile(resolve(outDir, 'index.html'), template.replaceAll('{{DIVE_VERSION}}', version));
await writeFile(resolve(outDir, '.nojekyll'), '');

const packed = spawnSync(
  process.execPath,
  [
    resolve(root, 'scripts/pack-dive.mjs'),
    resolve(root, 'examples/the_wealth_and_health_of_nations/story.json'),
    '-o',
    resolve(outDir, 'wealth.dive'),
  ],
  { cwd: root, stdio: 'inherit' },
);

if (packed.status !== 0) {
  process.exit(packed.status ?? 1);
}

console.log(`pages: dive-video@${version} + wealth.dive → ${outDir}`);
