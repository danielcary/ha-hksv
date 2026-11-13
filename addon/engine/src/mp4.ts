/** Incremental ISO BMFF framing. Only complete initialization and moof/mdat pairs escape. */
export class FragmentParser {
  private pending = Buffer.alloc(0);
  private initialization: Buffer[] = [];
  private initializationBytes = 0;
  private initialized = false;
  private moof?: Buffer;
  constructor(private onInit: (data: Buffer) => void, private onFragment: (data: Buffer) => void,
    private maxBoxBytes = 16 * 1024 * 1024) {}
  push(chunk: Buffer) {
    // FFmpeg stdout chunks are small; reject unbounded callers before allocating.
    if (chunk.length > this.maxBoxBytes) throw new Error('MP4 input chunk too large');
    this.pending = Buffer.concat([this.pending, chunk]);
    while (this.pending.length >= 8) {
      let length = this.pending.readUInt32BE(0);
      let header = 8;
      if (length === 1) {
        if (this.pending.length < 16) return;
        const extended = this.pending.readBigUInt64BE(8);
        if (extended > BigInt(this.maxBoxBytes)) throw new Error('MP4 box too large');
        length = Number(extended); header = 16;
      }
      if (length < header || length > this.maxBoxBytes) throw new Error('Invalid MP4 box size');
      if (this.pending.length < length) return;
      const box = Buffer.from(this.pending.subarray(0, length));
      this.pending = this.pending.subarray(length);
      const type = box.toString('ascii', 4, 8);
      if (!this.initialized) {
        if (!['ftyp', 'moov', 'free'].includes(type)) throw new Error('MP4 initialization missing');
        this.initializationBytes += length;
        if (this.initializationBytes > this.maxBoxBytes) throw new Error('MP4 initialization too large');
        this.initialization.push(box);
        if (type === 'moov') {
          this.initialized = true;
          this.onInit(Buffer.concat(this.initialization));
          this.initialization = [];
        }
      } else if (type === 'moof') {
        if (this.moof) throw new Error('Missing MP4 media data');
        this.moof = box;
      } else if (type === 'mdat') {
        if (!this.moof) throw new Error('Missing MP4 fragment header');
        this.onFragment(Buffer.concat([this.moof, box])); this.moof = undefined;
      } else if (!['free', 'mfra', 'styp', 'sidx'].includes(type)) {
        throw new Error('Unexpected MP4 box');
      }
    }
  }
  finish() {
    if (this.pending.length || this.moof || !this.initialized) throw new Error('Truncated MP4 stream');
  }
}

type Box = {type: string; start: number; payload: number; end: number};
function boxes(data: Buffer, start = 0, end = data.length): Box[] {
  const result: Box[] = [];
  while (start < end) {
    if (end - start < 8) throw new Error('Truncated MP4 box');
    let size = data.readUInt32BE(start); let header = 8;
    if (size === 1) {
      if (end - start < 16) throw new Error('Truncated MP4 box');
      const extended = data.readBigUInt64BE(start + 8);
      if (extended > BigInt(end - start)) throw new Error('Invalid MP4 box');
      size = Number(extended); header = 16;
    }
    if (size < header || size > end - start) throw new Error('Invalid MP4 box');
    result.push({type: data.toString('ascii', start + 4, start + 8), start, payload: start + header, end: start + size});
    start += size;
  }
  return result;
}
function child(data: Buffer, parent: Box, type: string): Box {
  const found = boxes(data, parent.payload, parent.end).find(box => box.type === type);
  if (!found) throw new Error('Missing MP4 timing box');
  return found;
}
function requireBytes(box: Box, length: number) {
  if (box.end - box.payload < length) throw new Error('Truncated MP4 timing box');
}

/** Each clip has its own clock; preserve track offsets without changing shared prebuffer bytes. */
export class FragmentTimeline {
  private timescales = new Map<number, bigint>();
  private origin?: {time: bigint; scale: bigint};
  private sequence = 0;
  constructor(init: Buffer) {
    const moov = boxes(init).find(box => box.type === 'moov');
    if (!moov) throw new Error('Missing MP4 initialization');
    for (const track of boxes(init, moov.payload, moov.end).filter(box => box.type === 'trak')) {
      const tkhd = child(init, track, 'tkhd'); const mdhd = child(init, child(init, track, 'mdia'), 'mdhd');
      requireBytes(tkhd, 4); requireBytes(mdhd, 4);
      if (init[tkhd.payload] > 1 || init[mdhd.payload] > 1) throw new Error('Unsupported MP4 timing version');
      const trackOffset = init[tkhd.payload] === 1 ? 20 : 12;
      const scaleOffset = init[mdhd.payload] === 1 ? 20 : 12;
      requireBytes(tkhd, trackOffset + 4); requireBytes(mdhd, scaleOffset + 4);
      const id = init.readUInt32BE(tkhd.payload + trackOffset);
      const scale = init.readUInt32BE(mdhd.payload + scaleOffset);
      if (!scale || this.timescales.has(id)) throw new Error('Invalid MP4 track timing');
      this.timescales.set(id, BigInt(scale));
    }
    if (!this.timescales.size) throw new Error('Missing MP4 tracks');
  }
  rebase(fragment: Buffer): Buffer {
    const data = Buffer.from(fragment);
    const moof = boxes(data).find(box => box.type === 'moof');
    if (!moof) throw new Error('Missing MP4 fragment');
    const timings = boxes(data, moof.payload, moof.end).filter(box => box.type === 'traf').map(traf => {
      const tfhd = child(data, traf, 'tfhd'); const tfdt = child(data, traf, 'tfdt');
      requireBytes(tfhd, 8); requireBytes(tfdt, 4);
      const scale = this.timescales.get(data.readUInt32BE(tfhd.payload + 4));
      const version = data[tfdt.payload];
      if (!scale || version > 1) throw new Error('Invalid MP4 fragment timing');
      requireBytes(tfdt, version === 1 ? 12 : 8);
      const offset = tfdt.payload + 4;
      const time = version === 1 ? data.readBigUInt64BE(offset) : BigInt(data.readUInt32BE(offset));
      return {offset, version, time, scale};
    });
    if (!timings.length) throw new Error('Missing MP4 fragment tracks');
    if (!this.origin) this.origin = timings.reduce((a, b) => a.time * b.scale <= b.time * a.scale ? a : b);
    for (const timing of timings) {
      const time = timing.time - this.origin.time * timing.scale / this.origin.scale;
      if (time < 0n) throw new Error('MP4 fragment precedes clip origin');
      if (timing.version === 1) data.writeBigUInt64BE(time, timing.offset);
      else data.writeUInt32BE(Number(time), timing.offset);
    }
    const mfhd = child(data, moof, 'mfhd'); requireBytes(mfhd, 8);
    data.writeUInt32BE(++this.sequence, mfhd.payload + 4);
    return data;
  }
}
