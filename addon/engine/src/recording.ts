import { ChildProcessWithoutNullStreams } from 'node:child_process';
import { CameraRecordingConfiguration, CameraRecordingDelegate, RecordingPacket } from '@homebridge/hap-nodejs';
import { CameraConfig } from './config.js';
import { FragmentBuffer } from './buffer.js';
import { FragmentParser, FragmentTimeline } from './mp4.js';
import { inputArguments, launch, terminate, videoArguments } from './ffmpeg.js';

/** One event retains the oldest footage when the Home hub is late or slow. */
export class RecordingEvent {
  private queue: Buffer[];
  private bytes: number;
  private wake?: () => void;
  private failure?: Error;
  closed = false;
  claimed = false;
  endRequested = false;
  constructor(readonly init: Buffer, prebuffer: Buffer[], private maxBytes = 32 * 1024 * 1024) {
    this.queue = prebuffer;
    this.bytes = prebuffer.reduce((sum, b) => sum + b.length, 0);
  }
  push(data: Buffer) {
    if (this.closed) return;
    if (this.bytes + data.length > this.maxBytes) { this.cancel(new Error('Recording consumer too slow')); return; }
    this.queue.push(data); this.bytes += data.length; this.wake?.();
  }
  cancel(error?: Error) { this.failure = error; this.closed = true; this.queue = []; this.bytes = 0; this.wake?.(); }
  async *packets(): AsyncGenerator<RecordingPacket> {
    yield {data: this.init, isLast: false};
    while (!this.closed) {
      if (!this.queue.length) await new Promise<void>(resolve => { this.wake = resolve; });
      this.wake = undefined;
      if (this.closed) break;
      const data = this.queue.shift()!; this.bytes -= data.length;
      const isLast = this.endRequested && this.queue.length === 0;
      yield {data, isLast};
      if (isLast) return;
    }
    if (this.failure) throw this.failure;
  }
}

export function recordingArguments(camera: CameraConfig, config: CameraRecordingConfiguration, audio: boolean): string[] {
  if (config.videoCodec.type !== 0 || config.mediaContainerConfiguration.type !== 0 || config.audioCodec.type !== 0
    || !Number.isFinite(config.prebufferLength) || config.prebufferLength < 0 || config.prebufferLength > 4000) throw new Error('Unsupported recording configuration');
  const [width, height, fps] = config.videoCodec.resolution;
  const params = config.videoCodec.parameters;
  const interval = Math.min(2000, config.mediaContainerConfiguration.fragmentLength, params.iFrameInterval);
  if (!Number.isFinite(interval) || interval < 1000) throw new Error('Unsupported fragment duration');
  const gop = Math.max(1, Math.floor(fps * interval / 1000));
  const sourceAudio = audio && camera.audio === true;
  const args = inputArguments(camera, sourceAudio);
  if (audio && !sourceAudio) args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=mono:sample_rate=48000');
  args.push(...videoArguments(width, height, fps, params.bitRate, params.profile, params.level, gop));
  if (audio) {
    if (config.audioCodec.samplerate !== 5 || (config.audioCodec.audioChannels ?? 1) !== 1
      || !Number.isFinite(config.audioCodec.bitrate) || config.audioCodec.bitrate <= 0 || config.audioCodec.bitrate > 320) throw new Error('Unsupported audio configuration');
    args.push('-map', sourceAudio ? '0:a:0?' : '1:a:0', '-c:a', 'aac', '-profile:a', 'aac_low', '-ar', '48000', '-ac', '1', '-b:a', `${config.audioCodec.bitrate}k`);
  } else args.push('-an');
  args.push('-movflags', '+frag_keyframe+empty_moov+default_base_moof', '-flush_packets', '1', '-f', 'mp4', 'pipe:1');
  return args;
}

export class RecordingDelegate implements CameraRecordingDelegate {
  private configuration?: CameraRecordingConfiguration;
  private active = false;
  private enabled = true;
  private audio = false;
  private motion = false;
  private child?: ChildProcessWithoutNullStreams;
  private buffer = new FragmentBuffer();
  private initialization?: Buffer;
  private event?: RecordingEvent;
  private stream?: {id: number; event: RecordingEvent};
  private postTimer?: NodeJS.Timeout;
  private expiryTimer?: NodeJS.Timeout;
  private maxTimer?: NodeJS.Timeout;
  private retryTimer?: NodeJS.Timeout;
  private watchdog?: NodeJS.Timeout;
  private pendingReconfigure = false;
  private stopped = false;
  status = 'disabled';
  constructor(private camera: CameraConfig) {}
  private log(event: string, details: Record<string, unknown> = {}) {
    // Only lifecycle metadata; never log media, camera URLs or HomeKit keys.
    console.info(JSON.stringify({component: 'recording', camera: this.camera.id, event, ...details}));
  }
  updateRecordingActive(active: boolean) { this.active = active; this.reconcile(); }
  updateRecordingConfiguration(configuration: CameraRecordingConfiguration | undefined) {
    this.configuration = configuration && structuredClone(configuration); this.reconcile();
  }
  setEnabled(enabled: boolean) { this.enabled = enabled; this.reconcile(); }
  setAudioActive(active: boolean) {
    if (this.audio === active) return;
    this.audio = active;
    // Privacy changes immediately invalidate queued audio, including active streams.
    this.stopPipeline(); this.reconcile();
  }
  setMotion(active: boolean) {
    const changed = this.motion !== active; this.motion = active;
    if (changed) this.log('motion', {active, status: this.status});
    if (active) {
      clearTimeout(this.postTimer);
      if (this.event) this.event.endRequested = false;
      if (changed) this.beginEvent();
    } else if (this.event) {
      clearTimeout(this.postTimer);
      this.postTimer = setTimeout(() => { if (this.event) this.event.endRequested = true; }, 4000);
    }
  }
  private beginEvent() {
    if (this.event || !this.initialization || !this.buffer.snapshot().length || !this.active || !this.enabled) return;
    const event = this.event = new RecordingEvent(this.initialization, this.buffer.snapshot());
    this.log('event_buffered');
    this.expiryTimer = setTimeout(() => { if (!event.claimed && this.event === event) { this.log('event_unclaimed'); this.finishEvent(); } }, 8000);
    this.maxTimer = setTimeout(() => { event.endRequested = true; }, 120000);
  }
  private reconcile() {
    if (this.stopped) return;
    if (!this.enabled || !this.active || !this.configuration) { this.stopPipeline(); this.status = 'disabled'; return; }
    if (this.stream) { this.pendingReconfigure = true; return; }
    this.stopPipeline();
    let args: string[];
    try { args = recordingArguments(this.camera, this.configuration, this.audio); }
    catch { this.status = 'unsupported_configuration'; return; }
    this.buffer = new FragmentBuffer(this.configuration.prebufferLength || 1);
    this.status = 'warming_up';
    const child = this.child = launch(args);
    const refreshWatchdog = () => {
      clearTimeout(this.watchdog);
      this.watchdog = setTimeout(() => failed(), 15000);
    };
    const failed = () => {
      if (this.child !== child) return;
      this.stopPipeline(); this.status = 'media_error';
      this.retryTimer = setTimeout(() => this.reconcile(), 5000);
    };
    const parser = new FragmentParser(data => { this.initialization = data; }, data => {
      refreshWatchdog();
      this.buffer.push(data, performance.now());
      if (this.status !== 'ready') this.log('ready');
      this.status = 'ready';
      this.event?.push(data);
      if (this.motion && !this.event) this.beginEvent();
    });
    child.stdout.on('data', (chunk: Buffer) => { if (this.child === child) { try { parser.push(chunk); } catch { failed(); } } });
    child.once('error', failed); child.once('close', failed);
    refreshWatchdog();
  }
  async *handleRecordingStreamRequest(id: number, signal?: AbortSignal): AsyncGenerator<RecordingPacket> {
    const event = this.event;
    if (!event || event.closed || this.stream || !this.active || !this.enabled) {
      this.log('stream_rejected', {id, status: this.status}); throw new Error('No recording event available');
    }
    const stream = this.stream = {id, event}; event.claimed = true; clearTimeout(this.expiryTimer);
    this.log('stream_opened', {id});
    const abort = () => event.cancel();
    signal?.addEventListener('abort', abort, {once: true});
    if (signal?.aborted) abort();
    let packets = 0; let bytes = 0; let sentEnd = false;
    try {
      const timeline = new FragmentTimeline(event.init);
      if (!event.closed) for await (const packet of event.packets()) {
        packets++; bytes += packet.data.length; sentEnd = packet.isLast;
        yield packets === 1 ? packet : {...packet, data: timeline.rebase(packet.data)};
      }
    } finally {
      this.log('stream_finished', {id, packets, bytes, sentEnd});
      signal?.removeEventListener('abort', abort);
      if (this.stream === stream) { this.stream = undefined; this.finishEvent(); }
      if (this.pendingReconfigure) { this.pendingReconfigure = false; this.reconcile(); }
    }
  }
  closeRecordingStream(id: number, reason?: number) {
    this.log('stream_closed', {id, reason});
    if (this.stream?.id === id) this.stream.event.cancel();
  }
  acknowledgeStream(id: number) { this.log('stream_acknowledged', {id}); this.closeRecordingStream(id); }
  private finishEvent() {
    clearTimeout(this.expiryTimer); clearTimeout(this.postTimer); clearTimeout(this.maxTimer);
    this.event?.cancel(); this.event = undefined;
  }
  private stopPipeline() {
    clearTimeout(this.retryTimer); clearTimeout(this.watchdog);
    const child = this.child; this.child = undefined;
    if (child) terminate(child);
    this.finishEvent(); this.initialization = undefined; this.buffer.clear();
  }
  close() { this.stopped = true; this.stopPipeline(); this.status = 'stopped'; }
}
