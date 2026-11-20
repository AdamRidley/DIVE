import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const root = resolve(import.meta.dirname, '..');
const temp = await mkdtemp(resolve(tmpdir(), 'dive-priority-'));
const channel = process.argv.find(arg => arg.startsWith('--channel='))?.split('=')[1];
const nativeFetch = globalThis.fetch;
let route;
const server = await createServer({
  root, configFile: false, optimizeDeps: { noDiscovery: true, include: [] },
  plugins: [{ name: 'priority-fixture', configureServer(server) {
    server.middlewares.use((req, res, next) => route ? route(req, res, next) : next());
  } }],
  server: { host: '127.0.0.1', port: 0, hmr: false },
});
let browser;
const sessions = [];
let releaseAudio;
try {
  const { openDivePack, loadDivePack, DivePackSession } = await server.ssrLoadModule('/src/core/dive-pack.ts');
  const indexEntry = manifest => ({ name: 'dive.json', data: new TextEncoder().encode(JSON.stringify(manifest)) });
  assert.throws(() => new DivePackSession().addEntry(indexEntry({ version: 3 })), /Unsupported DIVE pack version/);
  assert.throws(() => new DivePackSession().addEntry(indexEntry({ version: 2 })), /missing the file index/);
  await mkdir(resolve(temp, 'tools'));
  const story = {
    title: { en: 'Priority fixture', cy: 'Stori brawf' }, duration: 6000, aspectRatio: '16:9',
    languages: [{ code: 'en', label: 'English' }, { code: 'cy', label: 'Cymraeg' }],
    audio: [
      { src: 'en.wav', lang: 'en' }, { src: 'cy.wav', lang: 'cy' },
      { src: 'music.wav', role: 'music', loop: true },
    ],
    scenes: ['one', 'two', 'three'].map((id, i) => ({
      id, tool: `tools/${id}.html`, startTime: i * 2000, endTime: (i + 1) * 2000,
      keyframes: [{ time: 0, state: {} }], overlays: [],
    })),
  };
  await writeFile(resolve(temp, 'story.json'), JSON.stringify(story));
  for (const scene of story.scenes) {
    await writeFile(resolve(temp, scene.tool),
      '<!doctype html><script src="helper.js"></script><h1>Visible scene</h1><script>parent.postMessage({type:"DIVE_READY"},"*")</script>');
  }
  await writeFile(resolve(temp, 'tools/helper.js'), 'window.visualDependencyReady = true;');
  for (const name of ['en.wav', 'cy.wav', 'music.wav']) {
    const pcm = randomBytes(384000);
    const wav = Buffer.alloc(44);
    wav.write('RIFF'); wav.writeUInt32LE(pcm.length + 36, 4); wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(32000, 24); wav.writeUInt32LE(64000, 28);
    wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36);
    wav.writeUInt32LE(pcm.length, 40);
    await writeFile(resolve(temp, name), Buffer.concat([wav, pcm]));
  }
  const build = async format => {
    const output = resolve(temp, `v${format}.dive`);
    execFileSync(process.execPath, [resolve(root, 'scripts/pack-dive.mjs'),
      resolve(temp, 'story.json'), '-o', output, '--format', String(format)]);
    return new Uint8Array(await readFile(output));
  };
  const bytes = await build(2);
  const full = await loadDivePack(bytes);
  const manifest = full.manifest;
  assert.equal(manifest.version, 2);
  for (const [name, range] of Object.entries(manifest.files)) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + range.offset, range.length);
    assert.equal(view.getUint32(0, true), 0x04034b50);
    const nameLength = view.getUint16(26, true);
    assert.equal(new TextDecoder().decode(bytes.slice(range.offset + 30, range.offset + 30 + nameLength)), name);
    assert.equal(range.length, 30 + nameLength + view.getUint16(28, true) + view.getUint32(18, true));
  }
  assert.ok(manifest.files['tools/one.html'].offset < manifest.files['en.wav'].offset);
  assert.ok(manifest.files['music.wav'].offset < manifest.files['tools/two.html'].offset);
  assert.ok(manifest.files['tools/helper.js'].offset < manifest.files['tools/one.html'].offset);
  const ranges = [];
  const respond = async (_url, init) => {
    const match = /^bytes=(\d+)-(\d+)$/.exec(init.headers.Range);
    const start = Number(match[1]), end = Number(match[2]) + 1;
    ranges.push({ start, end });
    return new Response(bytes.slice(start, end), { status: 206 });
  };
  globalThis.fetch = respond;
  const session = await openDivePack('https://example.invalid/story.dive');
  sessions.push(session);
  const startupBytes = ranges.reduce((sum, range) => sum + range.end - range.start, 0);
  assert.ok(startupBytes < 32768, `Visual startup fetched ${startupBytes} bytes`);
  assert.ok(!session.files.has('en.wav') && !session.files.has('cy.wav'));
  assert.ok(session.files.has('tools/one.html'));
  for (let i = 0; i < ranges.length; i++) {
    for (let j = i + 1; j < ranges.length; j++) {
      assert.ok(ranges[i].end <= ranges[j].start || ranges[j].end <= ranges[i].start, 'Startup ranges must not overlap');
    }
  }
  const before = ranges.length;
  await Promise.all([session.ensureFiles(['cy.wav']), session.ensureFiles(['cy.wav'])]);
  assert.equal(ranges.length, before + 1, 'Concurrent audio requests must deduplicate');
  globalThis.fetch = async () => new Response(new Uint8Array(2), { status: 206 });
  await assert.rejects(session.ensureFiles(['en.wav']), /Truncated DIVE range/);
  globalThis.fetch = respond;
  session.backfill('cy', 0, false);
  await session.waitFor(Object.keys(manifest.files));
  assert.equal(ranges.at(-1).start, manifest.files['en.wav'].offset, 'Other narration must load last, not remain unloaded');

  ranges.length = 0;
  const deep = await openDivePack('https://example.invalid/story.dive', { timeMs: 4500 });
  sessions.push(deep);
  assert.ok(deep.files.has('tools/three.html'));
  assert.ok(!deep.files.has('tools/one.html'), 'Time deep links must fetch the requested scene directly');

  let releaseTail;
  const tail = new Promise(resolve => { releaseTail = resolve; });
  const audioStart = Math.min(...Object.values(manifest.files).filter(file => file.audio).map(file => file.offset));
  globalThis.fetch = async () => new Response(new ReadableStream({
    async start(controller) {
      controller.enqueue(bytes.slice(0, audioStart));
      await tail;
      controller.enqueue(bytes.slice(audioStart));
      controller.close();
    },
  }));
  const sequential = await openDivePack('https://example.invalid/sequential.dive');
  sessions.push(sequential);
  assert.ok(sequential.files.has('tools/one.html'));
  assert.equal(sequential.files.has('en.wav'), false, 'Sequential visuals must not wait for audio');
  releaseTail();
  await sequential.waitFor(Object.keys(manifest.files));

  let failStream;
  const streamFailure = new Promise(resolve => { failStream = resolve; });
  globalThis.fetch = async () => new Response(new ReadableStream({
    async start(controller) {
      controller.enqueue(bytes.slice(0, audioStart));
      await streamFailure;
      controller.error(new Error('Interrupted pack stream'));
    },
  }));
  const interrupted = await openDivePack('https://example.invalid/interrupted.dive');
  sessions.push(interrupted);
  const rejectedAudio = assert.rejects(interrupted.ensureFiles(['en.wav']), /Interrupted pack stream/);
  failStream();
  await rejectedAudio;

  const legacy = await build(1);
  globalThis.fetch = async (_url, init) => {
    const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(init.headers.Range);
    return new Response(legacy.slice(Number(start), Number(end) + 1), { status: 206 });
  };
  const old = await openDivePack('https://example.invalid/v1.dive');
  sessions.push(old);
  assert.equal(old.manifest.version, 1);
  assert.ok(old.files.has('en.wav') && old.files.has('tools/one.html'), 'V1 packs must retain legacy startup');
  globalThis.fetch = nativeFetch;

  const audioGate = new Promise(resolve => { releaseAudio = resolve; });
  let currentAudioGate = audioGate;
  let failAudioOnce = '';
  const requests = [];
  route = (req, res, next) => {
    if (req.url?.startsWith('/__priority-test')) {
      res.setHeader('Content-Type', 'text/html');
      res.end('<!doctype html><dive-video src="/__priority.dive" muted></dive-video><script type="module" src="/src/index.ts"></script>');
      return;
    }
    if (req.url !== '/__priority.dive') return next();
    const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
    if (!match) { res.end(bytes); return; }
    const start = Number(match[1]), end = Math.min(Number(match[2]) + 1, bytes.length);
    const audio = Object.entries(manifest.files).find(([, file]) => file.audio && file.offset === start)?.[0];
    requests.push({ start, end, audio });
    void (async () => {
      if (audio) await currentAudioGate;
      if (audio && audio === failAudioOnce) {
        failAudioOnce = '';
        res.statusCode = 503;
        res.end('Temporary audio failure');
        return;
      }
      res.statusCode = 206;
      res.setHeader('Content-Range', `bytes ${start}-${end - 1}/${bytes.length}`);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.end(bytes.slice(start, end));
    })();
  };
  await server.listen();
  browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${server.resolvedUrls.local[0]}__priority-test?lang=cy`);
  await page.waitForFunction(() => document.querySelector('dive-video')?.sceneReady && document.querySelector('dive-video')?.story);
  const player = page.locator('dive-video');
  assert.equal(await player.evaluate(el => el.packMediaReady), false);
  assert.ok(await player.locator('.media-buffer').isVisible());
  const visual = page.frames().find(frame => frame.url().startsWith('blob:'));
  assert.ok(visual && await visual.locator('h1').isVisible(), 'Real iframe must be visible while audio is blocked');
  assert.ok(await visual.evaluate(() => window.visualDependencyReady));
  const browserStartup = requests.filter(r => !r.audio).reduce((sum, r) => sum + r.end - r.start, 0);
  assert.ok(browserStartup < 32768, `Browser visual startup fetched ${browserStartup} bytes`);
  assert.ok(!requests.some(r => r.audio === 'en.wav'), 'Inactive narration must not compete with startup');
  await player.locator('.play-btn').click();
  await page.waitForTimeout(300);
  assert.equal(await player.evaluate(el => el.currentTime), 0, 'Playback must wait for selected-language audio');
  await player.locator('.play-btn').click();
  releaseAudio();
  await page.waitForFunction(() => document.querySelector('dive-video').packMediaReady);
  assert.equal(await player.evaluate(el => el.isPlaying), false, 'Finishing audio must respect a user pause');
  assert.equal(await player.evaluate(el => el.currentTime), 0);
  await player.locator('.play-btn').click();
  await page.waitForFunction(() => document.querySelector('dive-video').currentTime > 100);
  await player.locator('.play-btn').click();
  await page.waitForFunction(() => document.querySelector('dive-video').packSession.files.has('en.wav'));
  assert.equal(requests.filter(r => r.audio).at(-1).audio, 'en.wav');
  currentAudioGate = new Promise(resolve => { releaseAudio = resolve; });
  const second = await browser.newPage();
  await second.goto(`${server.resolvedUrls.local[0]}__priority-test?lang=cy`);
  await second.waitForFunction(() => document.querySelector('dive-video')?.activeToolId === 'one' && document.querySelector('dive-video').sceneReady);
  failAudioOnce = 'en.wav';
  await second.evaluate(() => document.querySelector('dive-video').addEventListener('dive-load-error',
    event => { window.mediaFailurePhase = event.detail.phase; }));
  const promotedAudio = second.waitForRequest(request =>
    request.url().endsWith('/__priority.dive')
    && request.headers().range?.startsWith(`bytes=${manifest.files['en.wav'].offset}-`));
  await second.locator('dive-video').evaluate(el => el.setLanguage('en'));
  await second.waitForFunction(() => document.querySelector('dive-video').packedAudioKey.includes('en.wav'));
  await promotedAudio;
  releaseAudio();
  await second.waitForFunction(() => document.querySelector('dive-video').packMediaError);
  assert.equal(await second.evaluate(() => window.mediaFailurePhase), 'media');
  await second.locator('dive-video .scene-error button').click();
  await second.waitForFunction(() => document.querySelector('dive-video').packMediaReady);
  assert.equal(await second.locator('dive-video').evaluate(el => el.playerLang), 'en', 'Stale Welsh completion must not revert the locale');
  assert.deepEqual(errors, []);
  console.log(`priority-pack: visual startup ${startupBytes} bytes; browser ${browserStartup} bytes before audio; V1/V2, deep links, sequential fallback, selected audio gating, deduplication and idle-language backfill passed`);
} finally {
  releaseAudio?.();
  globalThis.fetch = nativeFetch;
  await browser?.close();
  for (const session of sessions) for (const url of session.urls.values()) URL.revokeObjectURL(url);
  await server.close();
  await rm(temp, { recursive: true, force: true });
}
