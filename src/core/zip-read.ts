const LOCAL_SIG = 0x04034b50;
const STORE = 0;
const DEFLATE = 8;

function u16(view: DataView, offset: number): number {
  return view.getUint16(offset, true);
}

function u32(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

export async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('DecompressionStream is required to read .dive packs');
  }
  const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const stream = new Blob([copy]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function decodeEntry(buffer: Uint8Array, offset: number): Promise<{ entry: ZipEntry | null; next: number } | null> {
  if (offset + 30 > buffer.length) {
    return null;
  }
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const sig = u32(view, offset);
  if (sig !== LOCAL_SIG) {
    return { entry: null, next: offset };
  }

  const method = u16(view, offset + 8);
  const compSize = u32(view, offset + 18);
  const nameLen = u16(view, offset + 26);
  const extraLen = u16(view, offset + 28);
  const nameStart = offset + 30;
  const dataStart = nameStart + nameLen + extraLen;
  const dataEnd = dataStart + compSize;
  if (dataEnd > buffer.length) {
    return null;
  }

  const name = new TextDecoder().decode(buffer.subarray(nameStart, nameStart + nameLen));
  const payload = buffer.subarray(dataStart, dataEnd);
  let data: Uint8Array;
  if (method === STORE) {
    data = payload.slice();
  } else if (method === DEFLATE) {
    data = await inflateRaw(payload);
  } else {
    throw new Error(`Unsupported zip method ${method} for ${name}`);
  }

  return {
    entry: name && !name.endsWith('/') ? { name, data } : null,
    next: dataEnd,
  };
}

export class ZipStreamParser {
  private pending = new Uint8Array(0);

  async push(chunk: Uint8Array): Promise<ZipEntry[]> {
    if (chunk.length === 0) {
      return [];
    }
    const next = new Uint8Array(this.pending.length + chunk.length);
    next.set(this.pending, 0);
    next.set(chunk, this.pending.length);
    this.pending = next;
    return this.drain();
  }

  async end(): Promise<ZipEntry[]> {
    return this.drain();
  }

  private async drain(): Promise<ZipEntry[]> {
    const entries: ZipEntry[] = [];
    let offset = 0;
    while (true) {
      const parsed = await decodeEntry(this.pending, offset);
      if (!parsed) {
        break;
      }
      if (parsed.entry === null && parsed.next === offset) {
        break;
      }
      if (parsed.entry) {
        entries.push(parsed.entry);
      }
      offset = parsed.next;
    }
    if (offset > 0) {
      this.pending = this.pending.slice(offset);
    }
    return entries;
  }
}

export async function readZipEntries(buffer: Uint8Array): Promise<ZipEntry[]> {
  const parser = new ZipStreamParser();
  const first = await parser.push(buffer);
  const last = await parser.end();
  return [...first, ...last];
}

export function isZipBuffer(buffer: Uint8Array): boolean {
  return buffer.length >= 4
    && buffer[0] === 0x50
    && buffer[1] === 0x4b
    && buffer[2] === 0x03
    && buffer[3] === 0x04;
}

export function looksLikeDiveUrl(url: string): boolean {
  return /\.dive(?:$|[?#])/i.test(url);
}
