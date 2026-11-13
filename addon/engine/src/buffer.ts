/** Holds complete, independently decodable fMP4 fragments supplied by the media engine.
 * Timestamps are monotonic milliseconds. Initialization segments are managed separately.
 */
export class FragmentBuffer {
  private fragments: {data: Buffer; timestamp: number}[] = [];
  private bytes = 0;
  private lastTimestamp = -Infinity;
  constructor(private durationMs = 4000, private maxBytes = 16 * 1024 * 1024) {
    if (!Number.isFinite(durationMs) || durationMs <= 0 || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('Invalid limits');
  }
  push(data: Buffer, timestamp: number) {
    if (!Number.isFinite(timestamp) || timestamp < this.lastTimestamp) throw new Error('Non-monotonic timestamp');
    if (data.length > this.maxBytes) throw new Error('Fragment exceeds buffer limit');
    this.lastTimestamp = timestamp;
    this.fragments.push({data: Buffer.from(data), timestamp});
    this.bytes += data.length;
    // Keep one fragment crossing the time boundary so the requested prebuffer is covered.
    while (this.fragments.length > 1 && (this.fragments[1].timestamp <= timestamp - this.durationMs || this.bytes > this.maxBytes)) {
      this.bytes -= this.fragments.shift()!.data.length;
    }
  }
  snapshot(): Buffer[] { return this.fragments.map(fragment => Buffer.from(fragment.data)); }
  clear() { this.fragments = []; this.bytes = 0; this.lastTimestamp = -Infinity; }
}
