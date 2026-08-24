import { existsSync, readFileSync } from 'node:fs';

const required = [
  'dist/dive.js',
  'dist/dive.iife.js',
  'dist/dive.js.map',
  'dist/dive.iife.js.map',
  'dist/index.d.ts',
];

let failed = false;

for (const file of required) {
  if (!existsSync(file)) {
    console.error(`missing ${file}`);
    failed = true;
  }
}

if (!failed) {
  const esm = readFileSync('dist/dive.js', 'utf8');
  const iife = readFileSync('dist/dive.iife.js', 'utf8');
  const dts = readFileSync('dist/index.d.ts', 'utf8');

  if (!esm.includes('dive-video')) {
    console.error('dist/dive.js does not register dive-video');
    failed = true;
  }
  if (!iife.includes('dive-video')) {
    console.error('dist/dive.iife.js does not register dive-video');
    failed = true;
  }
  if (!dts.includes('DiveVideo') || !dts.includes('registerTool')) {
    console.error('dist/index.d.ts is missing public exports');
    failed = true;
  }
}

const leaked = [
  'dist/story.json',
  'dist/energy-data.json',
  'dist/custom-d3-tool.js',
  'dist/my-d3-tool.html',
].filter((file) => existsSync(file));

if (leaked.length) {
  console.error(`PoC fixtures leaked into library dist: ${leaked.join(', ')}`);
  failed = true;
}

if (failed) {
  process.exit(1);
}

console.log('dist ok');
