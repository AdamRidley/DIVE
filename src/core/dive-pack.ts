import { DIVE_MANIFEST_NAME, DIVE_STORY_NAME, DiveManifest } from './dive-manifest';
import { ZipEntry, ZipStreamParser, isZipBuffer, looksLikeDiveUrl, readZipEntries } from './zip-read';
import { Story } from './types';
export { looksLikeDiveUrl } from './zip-read';
export { DIVE_MANIFEST_NAME, DIVE_STORY_NAME } from './dive-manifest';

export interface DivePack {
  manifest: DiveManifest | null;
  story: Story;
  files: Map<string, Uint8Array>;
  urls: Map<string, string>;
}

function decodeText(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function toBlobPart(bytes: Uint8Array): BlobPart {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function looksRelativeRef(value: string): boolean {
  return Boolean(value)
    && !/^[a-zA-Z][a-zA-Z+\-.]*:/.test(value)
    && !value.startsWith('//');
}

function normalizePackPath(value: string): string {
  return value.replace(/^\.\//, '').replace(/^\/+/, '');
}

export function packHas(files: Map<string, Uint8Array>, ref: string): boolean {
  return files.has(normalizePackPath(ref));
}

export function blobUrlFor(pack: DivePack, ref: string): string | null {
  const key = normalizePackPath(ref);
  const existing = pack.urls.get(key);
  if (existing) {
    return existing;
  }
  const bytes = pack.files.get(key);
  if (!bytes) {
    return null;
  }
  const url = URL.createObjectURL(new Blob([toBlobPart(bytes)]));
  pack.urls.set(key, url);
  return url;
}

function rewriteString(pack: DivePack, value: string): string {
  if (!looksRelativeRef(value)) {
    return value;
  }
  return blobUrlFor(pack, value) || value;
}

function rewriteMaybeLocalized(pack: DivePack, value: unknown): unknown {
  if (typeof value === 'string') {
    return rewriteString(pack, value);
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const next: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      next[key] = typeof entry === 'string' ? rewriteString(pack, entry) : entry;
    }
    return next;
  }
  return value;
}

export function rewriteStoryForPack(story: Story, pack: DivePack): Story {
  const next = structuredClone(story) as Story;
  if (next.poster) {
    next.poster = rewriteString(pack, next.poster);
  }
  if (typeof next.audio === 'string') {
    next.audio = rewriteString(pack, next.audio);
  } else if (Array.isArray(next.audio)) {
    next.audio = next.audio.map((clip) => (
      typeof clip === 'string'
        ? rewriteString(pack, clip)
        : { ...clip, src: rewriteString(pack, clip.src) }
    )) as Story['audio'];
  } else if (next.audio && typeof next.audio === 'object') {
    next.audio = { ...next.audio, src: rewriteString(pack, next.audio.src) };
  }

  if (typeof next.captions === 'string') {
    next.captions = rewriteString(pack, next.captions);
  } else if (Array.isArray(next.captions)) {
    next.captions = next.captions.map((item) => {
      if (typeof item === 'string') {
        return rewriteString(pack, item);
      }
      if (item && typeof item === 'object' && 'src' in item && typeof item.src === 'string') {
        return { ...item, src: rewriteString(pack, item.src) };
      }
      return item;
    }) as Story['captions'];
  } else if (next.captions && typeof next.captions === 'object' && next.captions.src) {
    next.captions = { ...next.captions, src: rewriteString(pack, next.captions.src) };
  }

  for (const scene of next.scenes) {
    const originalTool = scene.tool;
    scene.tool = rewriteString(pack, originalTool);
    scene.tool = materializePackedTool(pack, originalTool, scene.tool);
    if (typeof scene.data === 'string') {
      scene.data = rewriteString(pack, scene.data);
    }
    for (const overlay of scene.overlays) {
      overlay.content = rewriteMaybeLocalized(pack, overlay.content) as typeof overlay.content;
    }
  }

  return next;
}

function injectPackShim(html: string, toolPath: string, urls: Map<string, string>): string {
  const packJson = JSON.stringify(Object.fromEntries(urls));
  const shim = `<script data-dive-pack-shim>(function(){
var PACK=${packJson};
var TOOL=${JSON.stringify(toolPath)};
var NativeURL=window.URL;
function remapBase(base){
  if(!base) return base;
  var s=String(base);
  if(s.indexOf('blob:')===0 || s===window.location.href) return 'https://dive.invalid/'+TOOL;
  return base;
}
function remap(raw){
  if(typeof raw!=='string') return raw;
  if(PACK[raw]) return PACK[raw];
  try{
    var u=new NativeURL(raw, remapBase(window.location.href));
    if(u.hostname==='dive.invalid'){
      var path=decodeURIComponent(u.pathname.replace(/^\\//,''));
      if(PACK[path]) return PACK[path];
    }
  }catch(e){}
  return raw;
}
window.URL=function(url, base){
  var u=new NativeURL(url, remapBase(base));
  if(u.hostname==='dive.invalid'){
    var path=decodeURIComponent(u.pathname.replace(/^\\//,''));
    if(PACK[path]) return new NativeURL(PACK[path]);
  }
  return u;
};
window.URL.prototype=NativeURL.prototype;
window.URL.createObjectURL=NativeURL.createObjectURL.bind(NativeURL);
window.URL.revokeObjectURL=NativeURL.revokeObjectURL.bind(NativeURL);
var nativeFetch=window.fetch.bind(window);
window.fetch=function(input, init){
  var raw=typeof input==='string'?input:(input&&input.url)||String(input);
  var mapped=remap(raw);
  if(mapped!==raw && typeof input==='string') return nativeFetch(mapped, init);
  return nativeFetch(input, init);
};
})();</script>`;

  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (match) => `${match}\n${shim}`);
  }
  return `${shim}\n${html}`;
}

export function materializePackedTool(pack: DivePack, originalToolPath: string, rewrittenTool: string): string {
  if (!rewrittenTool.startsWith('blob:')) {
    return rewrittenTool;
  }
  const key = normalizePackPath(originalToolPath);
  if (!key.endsWith('.html') && !key.endsWith('.htm')) {
    return rewrittenTool;
  }
  const bytes = pack.files.get(key);
  if (!bytes) {
    return rewrittenTool;
  }
  const html = injectPackShim(decodeText(bytes), key, pack.urls);
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  pack.urls.set(key, url);
  return url;
}

export async function loadDivePack(buffer: Uint8Array): Promise<DivePack> {
  const entries = await readZipEntries(buffer);
  const files = new Map<string, Uint8Array>();
  for (const entry of entries) {
    files.set(entry.name, entry.data);
  }

  const storyBytes = files.get(DIVE_STORY_NAME);
  if (!storyBytes) {
    throw new Error('.dive pack is missing story.json');
  }

  let manifest: DiveManifest | null = null;
  const manifestBytes = files.get(DIVE_MANIFEST_NAME);
  if (manifestBytes) {
    manifest = JSON.parse(decodeText(manifestBytes)) as DiveManifest;
  }

  const story = JSON.parse(decodeText(storyBytes)) as Story;
  const pack: DivePack = { manifest, story, files, urls: new Map() };
  for (const name of files.keys()) {
    blobUrlFor(pack, name);
  }
  pack.story = rewriteStoryForPack(story, pack);
  return pack;
}

export function shouldLoadAsDive(url: string, buffer?: Uint8Array): boolean {
  return looksLikeDiveUrl(url) || Boolean(buffer && isZipBuffer(buffer));
}

export function filesNeededToStart(manifest: DiveManifest | null): string[] {
  const names = [DIVE_STORY_NAME];
  if (!manifest) {
    return names;
  }
  names.unshift(DIVE_MANIFEST_NAME);
  names.push(...manifest.shared);
  const first = manifest.scenes.find((scene) => scene.files.length > 0) || manifest.scenes[0];
  if (first) {
    names.push(...first.files);
  }
  return [...new Set(names)];
}

export function filesForScene(manifest: DiveManifest | null, sceneId: string): string[] {
  if (!manifest) {
    return [];
  }
  const scene = manifest.scenes.find((item) => item.id === sceneId);
  return scene ? [...scene.files] : [];
}

export class DivePackSession implements DivePack {
  manifest: DiveManifest | null = null;
  story: Story = { title: '', duration: 0, scenes: [] };
  files = new Map<string, Uint8Array>();
  urls = new Map<string, string>();
  private rawStory: Story | null = null;
  private waiters: Array<{ names: string[]; resolve: () => void }> = [];
  finished = false;

  addEntry(entry: ZipEntry): void {
    this.files.set(entry.name, entry.data);
    blobUrlFor(this, entry.name);
    if (entry.name === DIVE_MANIFEST_NAME) {
      this.manifest = JSON.parse(decodeText(entry.data)) as DiveManifest;
    }
    if (entry.name === DIVE_STORY_NAME) {
      this.rawStory = JSON.parse(decodeText(entry.data)) as Story;
      this.refreshStory();
    } else if (this.rawStory) {
      this.refreshStory();
    }
    this.flushWaiters();
  }

  refreshStory(): void {
    if (!this.rawStory) {
      return;
    }
    this.story = rewriteStoryForPack(this.rawStory, this);
  }

  hasAll(names: string[]): boolean {
    return names.every((name) => this.files.has(name));
  }

  waitFor(names: string[]): Promise<void> {
    const needed = [...new Set(names.filter(Boolean))];
    if (this.hasAll(needed)) {
      return Promise.resolve();
    }
    if (this.finished && !this.hasAll(needed)) {
      return Promise.reject(new Error(`Pack finished without: ${needed.filter((name) => !this.files.has(name)).join(', ')}`));
    }
    return new Promise((resolve) => {
      this.waiters.push({ names: needed, resolve });
    });
  }

  markFinished(): void {
    this.finished = true;
    this.flushWaiters();
  }

  private flushWaiters(): void {
    this.waiters = this.waiters.filter((waiter) => {
      if (this.hasAll(waiter.names)) {
        waiter.resolve();
        return false;
      }
      return true;
    });
  }
}

export async function openDivePackStream(response: Response, onEntry?: (name: string) => void): Promise<DivePackSession> {
  const session = new DivePackSession();
  const parser = new ZipStreamParser();
  const reader = response.body?.getReader();

  const consume = async (chunk: Uint8Array) => {
    for (const entry of await parser.push(chunk)) {
      session.addEntry(entry);
      onEntry?.(entry.name);
    }
  };

  if (!reader) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    await consume(buffer);
    for (const entry of await parser.end()) {
      session.addEntry(entry);
      onEntry?.(entry.name);
    }
    session.markFinished();
    return session;
  }

  const pump = (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (value) {
          await consume(value);
        }
      }
      for (const entry of await parser.end()) {
        session.addEntry(entry);
        onEntry?.(entry.name);
      }
    } finally {
      session.markFinished();
    }
  })();

  void pump;
  return session;
}
