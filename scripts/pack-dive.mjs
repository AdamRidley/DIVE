#!/usr/bin/env node
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { dirname, posix, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import zlib from 'node:zlib';

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const DEFLATE = 8;

function dosDateTime(date = new Date()) {
  const dosTime = (date.getSeconds() / 2) | (date.getMinutes() << 5) | (date.getHours() << 11);
  const dosDate = date.getDate() | ((date.getMonth() + 1) << 5) | ((date.getFullYear() - 1980) << 9);
  return { dosTime, dosDate };
}

function crc32(buf) {
  return zlib.crc32(buf) >>> 0;
}

function u16(value) {
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(value, 0);
  return buf;
}

function u32(value) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value, 0);
  return buf;
}

function isRemote(value) {
  return /^(https?:)?\/\//i.test(value) || /^data:/i.test(value) || /^blob:/i.test(value);
}

function isPackableRef(value) {
  if (typeof value !== 'string' || !value || isRemote(value)) {
    return false;
  }
  if (value === 'map' || value === 'scatterplot') {
    return false;
  }
  return /[./]/.test(value) || /\.[a-z0-9]+$/i.test(value);
}

function asPosix(filePath) {
  return filePath.split(sep).join('/');
}

function uniquePush(list, value) {
  if (value && !list.includes(value)) {
    list.push(value);
  }
}

function collectStringRefs(story) {
  const shared = [];
  const perScene = new Map();

  const addShared = (value) => {
    if (isPackableRef(value)) {
      uniquePush(shared, value);
    }
  };

  const addScene = (sceneId, value) => {
    if (!isPackableRef(value)) {
      return;
    }
    if (!perScene.has(sceneId)) {
      perScene.set(sceneId, []);
    }
    uniquePush(perScene.get(sceneId), value);
  };

  const addLocalized = (bucket, value) => {
    if (typeof value === 'string') {
      bucket(value);
      return;
    }
    if (value && typeof value === 'object') {
      for (const entry of Object.values(value)) {
        if (typeof entry === 'string') {
          bucket(entry);
        }
      }
    }
  };

  addShared(story.poster);
  if (typeof story.audio === 'string') {
    addShared(story.audio);
  } else if (Array.isArray(story.audio)) {
    for (const clip of story.audio) {
      addShared(typeof clip === 'string' ? clip : clip?.src);
    }
  } else if (story.audio?.src) {
    addShared(story.audio.src);
  }

  if (typeof story.captions === 'string') {
    addShared(story.captions);
  } else if (Array.isArray(story.captions)) {
    for (const item of story.captions) {
      if (typeof item === 'string') {
        addShared(item);
      } else if (item?.src) {
        addShared(item.src);
      }
    }
  } else if (story.captions?.src) {
    addShared(story.captions.src);
  }

  for (const asset of story.assets || []) {
    addShared(asset?.src);
  }
  for (const dep of story.dependencies || []) {
    addShared(dep);
  }

  for (const scene of story.scenes || []) {
    addScene(scene.id, scene.tool);
    if (typeof scene.data === 'string') {
      addScene(scene.id, scene.data);
    }
    for (const dep of scene.dependencies || []) {
      addScene(scene.id, dep);
    }
    for (const overlay of scene.overlays || []) {
      if (overlay.type === 'image' || overlay.type === 'audio') {
        addLocalized((value) => addScene(scene.id, value), overlay.content);
      }
    }
  }

  return { shared, perScene };
}

const TOOL_ASSET_RE = /['"]((?:\.\.\/|\.\/)[^'"]+\.(?:json|csv|tsv|geojson|svg|png|jpe?g|webp|gif|vtt|mp3|wav|ogg|js|css|html?))['"]/gi;

async function discoverToolRefs(storyDir, toolRef) {
  const disk = await resolveOnDisk(storyDir, toolRef);
  if (!disk || !/\.(html?|js)$/i.test(disk)) {
    return [];
  }
  const text = await readFile(disk, 'utf8');
  const found = [];
  for (const match of text.matchAll(TOOL_ASSET_RE)) {
    const abs = resolve(dirname(disk), match[1]);
    uniquePush(found, asPosix(relative(storyDir, abs)));
  }
  return found;
}

async function resolveOnDisk(storyDir, ref) {
  const trimmed = ref.replace(/^\.\//, '');
  const candidates = [];
  if (trimmed.startsWith('/')) {
    candidates.push(resolve(storyDir, trimmed.slice(1)));
    candidates.push(resolve(process.cwd(), trimmed.slice(1)));
    candidates.push(resolve(process.cwd(), 'public', trimmed.slice(1)));
  } else {
    candidates.push(resolve(storyDir, trimmed));
  }

  for (const candidate of candidates) {
    try {
      const info = await stat(candidate);
      if (info.isFile()) {
        return candidate;
      }
    } catch {
      // try next
    }
  }
  return null;
}

function localHeader(nameBuf, { dosTime, dosDate }, crc, comp, raw, method) {
  return Buffer.concat([
    u32(LOCAL_SIG),
    u16(20),
    u16(0),
    u16(method),
    u16(dosTime),
    u16(dosDate),
    u32(crc),
    u32(comp.length),
    u32(raw.length),
    u16(nameBuf.length),
    u16(0),
    nameBuf,
    comp,
  ]);
}

function centralHeader(nameBuf, { dosTime, dosDate }, crc, comp, raw, method, offset) {
  return Buffer.concat([
    u32(CENTRAL_SIG),
    u16(20),
    u16(20),
    u16(0),
    u16(method),
    u16(dosTime),
    u16(dosDate),
    u32(crc),
    u32(comp.length),
    u32(raw.length),
    u16(nameBuf.length),
    u16(0),
    u16(0),
    u16(0),
    u16(0),
    u32(0),
    u32(offset),
    nameBuf,
  ]);
}

function eocd(entries, centralSize, centralOffset) {
  return Buffer.concat([
    u32(EOCD_SIG),
    u16(0),
    u16(0),
    u16(entries),
    u16(entries),
    u32(centralSize),
    u32(centralOffset),
    u16(0),
  ]);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
    console.log('Usage: node scripts/pack-dive.mjs <story.json> [-o out.dive]');
    process.exit(args.length === 0 ? 1 : 0);
  }

  let storyPath = null;
  let outPath = null;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '-o' || args[i] === '--output') {
      outPath = args[i + 1];
      i += 1;
    } else if (!args[i].startsWith('-')) {
      storyPath = args[i];
    }
  }

  if (!storyPath) {
    throw new Error('story.json path is required');
  }

  const absStory = resolve(process.cwd(), storyPath);
  const storyDir = dirname(absStory);
  const story = JSON.parse(await readFile(absStory, 'utf8'));
  const { shared, perScene } = collectStringRefs(story);
  for (const scene of story.scenes || []) {
    if (isPackableRef(scene.tool)) {
      for (const extra of await discoverToolRefs(storyDir, scene.tool)) {
        uniquePush(shared, extra);
      }
    }
  }
  const used = new Set();
  const planned = [];

  const addFile = async (ref, bucket) => {
    if (!ref || used.has(ref)) {
      return;
    }
    const disk = await resolveOnDisk(storyDir, ref);
    if (!disk) {
      console.warn(`skip missing local file: ${ref}`);
      return;
    }
    used.add(ref);
    const packName = asPosix(posix.normalize(ref.replace(/^\.\//, '').replace(/^\/+/, '')));
    const raw = await readFile(disk);
    const comp = zlib.deflateRawSync(raw);
    planned.push({
      ref,
      packName,
      bucket,
      raw,
      comp,
      crc: crc32(raw),
    });
  };

  await addFile(relative(storyDir, absStory) || 'story.json', 'story');
  // Always store the story as story.json at the pack root.
  if (planned[0]) {
    planned[0].packName = 'story.json';
  }

  for (const ref of shared) {
    await addFile(ref, 'shared');
  }

  const sceneIds = [...(story.scenes || [])]
    .sort((a, b) => a.startTime - b.startTime)
    .map((scene) => scene.id);

  for (const sceneId of sceneIds) {
    for (const ref of perScene.get(sceneId) || []) {
      await addFile(ref, sceneId);
    }
  }

  const languages = (story.languages || []).map((item) => item.code).filter(Boolean);
  const defaultLanguage = (story.languages || []).find((item) => item.default)?.code
    || languages[0]
    || 'en';

  const stamp = dosDateTime();
  const built = [];
  let cursor = 0;

  const manifestStub = {
    version: 1,
    story: 'story.json',
    defaultLanguage,
    languages: languages.length ? languages : [defaultLanguage],
    shared: planned.filter((item) => item.bucket === 'shared').map((item) => item.packName),
    scenes: sceneIds.map((id) => ({
      id,
      files: planned.filter((item) => item.bucket === id).map((item) => item.packName),
      offset: 0,
      length: 0,
    })),
  };

  const manifestRaw = Buffer.from(`${JSON.stringify(manifestStub, null, 2)}\n`, 'utf8');
  const manifestComp = zlib.deflateRawSync(manifestRaw);
  const manifestEntry = {
    packName: 'dive.json',
    raw: manifestRaw,
    comp: manifestComp,
    crc: crc32(manifestRaw),
    offset: 0,
  };

  const headerSize = (name) => 30 + Buffer.byteLength(name, 'utf8');
  cursor = headerSize('dive.json') + manifestComp.length;

  for (const item of planned) {
    item.offset = cursor;
    cursor += headerSize(item.packName) + item.comp.length;
    built.push(item);
  }

  const sceneMeta = sceneIds.map((id) => {
    const files = built.filter((item) => item.bucket === id);
    if (files.length === 0) {
      return { id, files: [], offset: 0, length: 0 };
    }
    const start = files[0].offset;
    const last = files[files.length - 1];
    const end = last.offset + headerSize(last.packName) + last.comp.length;
    return {
      id,
      files: files.map((item) => item.packName),
      offset: start,
      length: end - start,
    };
  });

  const manifest = {
    ...manifestStub,
    shared: built.filter((item) => item.bucket === 'shared').map((item) => item.packName),
    scenes: sceneMeta,
  };
  manifestEntry.raw = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  manifestEntry.comp = zlib.deflateRawSync(manifestEntry.raw);
  manifestEntry.crc = crc32(manifestEntry.raw);

  const out = outPath
    ? resolve(process.cwd(), outPath)
    : resolve(storyDir, `${posix.basename(absStory, '.json')}.dive`);
  await mkdir(dirname(out), { recursive: true });

  const chunks = [];
  const centrals = [];
  let offset = 0;
  const writeEntry = (name, raw, comp, crc) => {
    const nameBuf = Buffer.from(name, 'utf8');
    const local = localHeader(nameBuf, stamp, crc, comp, raw, DEFLATE);
    const central = centralHeader(nameBuf, stamp, crc, comp, raw, DEFLATE, offset);
    chunks.push(local);
    centrals.push(central);
    offset += local.length;
  };

  writeEntry('dive.json', manifestEntry.raw, manifestEntry.comp, manifestEntry.crc);
  for (const item of built) {
    writeEntry(item.packName, item.raw, item.comp, item.crc);
  }

  const centralStart = offset;
  const centralBuf = Buffer.concat(centrals);
  const tail = eocd(centrals.length, centralBuf.length, centralStart);
  const archive = Buffer.concat([...chunks, centralBuf, tail]);
  await pipeline(Readable.from(archive), createWriteStream(out));

  console.log(`wrote ${out}`);
  console.log(`entries: ${centrals.length} (dive.json + story + ${manifest.shared.length} shared + scene files)`);
  for (const scene of manifest.scenes) {
    console.log(`  scene ${scene.id}: ${scene.files.length} files @ ${scene.offset}+${scene.length}`);
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
