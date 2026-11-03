import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createServer } from 'vite';

const root = resolve(import.meta.dirname, '..');
const temp = await mkdtemp(resolve(tmpdir(), 'dive-loading-'));
const server = await createServer({
  configFile: false, root, server: { middlewareMode: true },
  optimizeDeps: { noDiscovery: true, include: [] },
});
const nativeFetch = globalThis.fetch;
const urls = new Set();

try {
  const { DivePackSession, loadDivePack, openDivePack } = await server.ssrLoadModule('/src/core/dive-pack.ts');
  const scene = (id, tool, startTime) => ({
    id, tool, startTime, endTime: startTime + 1000,
    keyframes: [{ time: 0, state: {} }], overlays: [],
  });
  const story = {
    title: 'Loading regression', duration: 2000,
    scenes: [scene('one', 'tools/one.html', 0), scene('two', 'tools/two.html', 1000)],
  };
  await mkdir(resolve(temp, 'tools'));
  await writeFile(resolve(temp, 'story.json'), JSON.stringify(story));
  await writeFile(resolve(temp, 'tools', 'one.html'),
    '<html><head><script src="helper.js"></script></head><body><iframe src="./nested.html"></iframe></body></html>');
  await writeFile(resolve(temp, 'tools', 'two.html'),
    '<html><head><script src = "helper.js?v=1"></script></head><body></body></html>');
  await writeFile(resolve(temp, 'tools', 'nested.html'),
    '<html><head><script src="nested-helper.js"></script></head><body></body></html>');
  await writeFile(resolve(temp, 'tools', 'helper.js'), 'window.helperLoaded = true;');
  await writeFile(resolve(temp, 'tools', 'nested-helper.js'), 'window.nestedHelperLoaded = true;');
  const path = resolve(temp, 'story.dive');
  execFileSync(process.execPath, [resolve(root, 'scripts', 'pack-dive.mjs'), resolve(temp, 'story.json'), '-o', path]);
  const bytes = new Uint8Array(await readFile(path));
  const pack = await loadDivePack(bytes);
  for (const url of pack.urls.values()) urls.add(url);
  for (const name of ['tools/helper.js', 'tools/nested-helper.js', 'tools/nested.html']) {
    assert.ok(pack.manifest.shared.includes(name), `${name} must be available before the first scene`);
  }
  assert.ok(!pack.manifest.shared.includes('tools/two.html'), 'later scene tools must stay range-loadable');
  for (const item of pack.story.scenes) {
    const html = await (await nativeFetch(item.tool)).text();
    assert.ok(html.includes(`src="${pack.urls.get('tools/helper.js')}"`), 'bare script references must resolve to packed blobs');
  }

  const session = new DivePackSession();
  const add = (name, text) => session.addEntry({ name, data: new TextEncoder().encode(text) });
  add('story.json', JSON.stringify(story));
  add('tools/nested.html', '<head><script src="nested-helper.js"></script></head>');
  add('tools/one.html', '<head></head><iframe src="./nested.html"></iframe>');
  session.refreshStory();
  const oldNested = session.urls.get('tools/nested.html');
  add('tools/nested-helper.js', 'window.nestedHelperLoaded = true;');
  session.refreshStory();
  const nested = session.urls.get('tools/nested.html');
  assert.notEqual(nested, oldNested, 'late dependencies must invalidate materialized nested pages');
  assert.ok((await (await nativeFetch(nested)).text()).includes(session.urls.get('tools/nested-helper.js')));
  const stable = session.story.scenes[0].tool;
  session.refreshStory();
  assert.equal(session.story.scenes[0].tool, stable, 'refresh without new files must reuse the prepared tool URL');
  for (const url of session.urls.values()) urls.add(url);

  // Hosts that reject Range must not return an empty story before the stream is read.
  let requests = 0;
  globalThis.fetch = async () => {
    if (++requests === 1) throw new Error('Range not supported');
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.slice(0, 30));
        setTimeout(() => { controller.enqueue(bytes.slice(30)); controller.close(); }, 20);
      },
    }));
  };
  const streamed = await openDivePack('https://example.invalid/story.dive');
  assert.equal(streamed.story.scenes.length, 2);
  assert.ok(streamed.story.scenes[0].tool.startsWith('blob:'));
  assert.ok(streamed.hasAll(['tools/helper.js', 'tools/nested-helper.js']));
  for (const url of streamed.urls.values()) urls.add(url);

  const retrySession = new DivePackSession();
  retrySession.sourceUrl = 'https://example.invalid/story.dive';
  let attempts = 0;
  globalThis.fetch = async () => {
    if (++attempts === 1) throw new Error('Temporary network failure');
    return new Response(bytes);
  };
  await assert.rejects(retrySession.fetchRange({ offset: 0, length: bytes.length }), /Temporary network failure/);
  await retrySession.fetchRange({ offset: 0, length: bytes.length });
  assert.equal(attempts, 2, 'a failed byte range must be retried, not cached permanently');
  assert.ok(retrySession.finished);
  for (const url of retrySession.urls.values()) urls.add(url);
  console.log('dive-loading: bare and nested dependencies, stable blobs, sequential fallback, range retry ok');
} finally {
  globalThis.fetch = nativeFetch;
  for (const url of urls) URL.revokeObjectURL(url);
  await server.close();
  await rm(temp, { recursive: true, force: true });
}
