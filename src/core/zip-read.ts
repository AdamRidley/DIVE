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
  const stream = new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function readZipEntries(buffer: Uint8Array): Promise<ZipEntry[]> {
  const entries: ZipEntry[] = [];
  let offset = 0;
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  while (offset + 30 <= buffer.length) {
    const sig = u32(view, offset);
    if (sig !== LOCAL_SIG) {
      break;
    }

    const method = u16(view, offset + 8);
    const compSize = u32(view, offset + 18);
    const nameLen = u16(view, offset + 26);
    const extraLen = u16(view, offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLen + extraLen;
    const dataEnd = dataStart + compSize;
    if (dataEnd > buffer.length) {
      throw new Error('Truncated zip local file entry');
    }

    const name = new TextDecoder().decode(buffer.subarray(nameStart, nameStart + nameLen));
    const payload = buffer.subarray(dataStart, dataEnd);
    const data = method === STORE
      ? payload.slice()
      : method === DEFLATE
        ? await inflateRaw(payload)
        : (() => { throw new Error(`Unsupported zip method ${method} for ${name}`); })();

    if (name && !name.endsWith('/')) {
      entries.push({ name, data });
    }
    offset = dataEnd;
  }

  return entries;
}

export function isZipBuffer(buffer: Uint8Array): boolean {
  return buffer.length >= 4
    && buffer[0] === 0x50
    && buffer[1] === 0x4b
    && buffer[2] === 0x03
    && buffer[3] === 0x04;
}
