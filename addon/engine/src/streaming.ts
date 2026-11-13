import { createSocket, Socket } from 'node:dgram';
import { isIP } from 'node:net';
import { ChildProcessWithoutNullStreams } from 'node:child_process';
import { CameraController, CameraStreamingDelegate, PrepareStreamRequest, PrepareStreamCallback,
  StreamingRequest, StreamRequestCallback, SnapshotRequest, SnapshotRequestCallback, Source, SourceResponse } from '@homebridge/hap-nodejs';
import { CameraConfig } from './config.js';
import { inputArguments, launch, terminate, snapshot, videoArguments } from './ffmpeg.js';
import { forwardOpus, opusArguments } from './live-audio.js';

export const LIVE_STREAM_COUNT = 2;

type Endpoint = {socket: Socket; ssrc: number};
type Session = {request: PrepareStreamRequest; video: Endpoint; audio?: Endpoint; audioInput?: Socket;
  child?: ChildProcessWithoutNullStreams; timer?: NodeJS.Timeout; videoReleased: boolean; cancelPrepare?: () => void};

function supportedSource(source: Source) {
  return source.srtpCryptoSuite === 0 && source.srtp_key.length === 16 && source.srtp_salt.length === 14
    && Number.isInteger(source.port) && source.port >= 1 && source.port <= 65535;
}
function endpointResponse(endpoint: Endpoint, source: Source): SourceResponse {
  return {port: endpoint.socket.address().port, ssrc: endpoint.ssrc, srtp_key: source.srtp_key, srtp_salt: source.srtp_salt};
}

export class StreamingDelegate implements CameraStreamingDelegate {
  private sessions = new Map<string, Session>();
  private enabled = true;
  private snapshots = new Set<AbortController>();
  private microphoneMuted = false;
  private microphoneVolume = 100;
  controller?: CameraController;
  constructor(private camera: CameraConfig) {}
  private log(event: string, details: Record<string, unknown> = {}) {
    // Only explicit diagnostic fields: never include RTSP URLs, pairing data or SRTP keys.
    console.info(JSON.stringify({component: 'live', camera: this.camera.id, event, ...details}));
  }
  handleSnapshotRequest(request: SnapshotRequest, callback: SnapshotRequestCallback) {
    this.log('snapshot_requested', {width: request.width, height: request.height});
    if (!this.enabled || this.snapshots.size >= 2) { callback(new Error('Camera unavailable')); return; }
    const abort = new AbortController(); this.snapshots.add(abort);
    snapshot(this.camera, request.width, request.height, abort.signal).then(
      data => { this.log('snapshot_ready'); callback(undefined, data); },
      () => { this.log('snapshot_failed'); callback(new Error('Snapshot failed')); },
    ).finally(() => this.snapshots.delete(abort));
  }
  prepareStream(request: PrepareStreamRequest, callback: PrepareStreamCallback) {
    this.log('prepare', {addressVersion: request.addressVersion, target: request.targetAddress,
      port: request.video.port, enabled: this.enabled, sessions: this.sessions.size});
    if (!this.enabled || this.sessions.size >= LIVE_STREAM_COUNT || this.sessions.has(request.sessionID)
      || isIP(request.targetAddress) !== (request.addressVersion === 'ipv4' ? 4 : 6)
      || !supportedSource(request.video) || (this.camera.audio && !supportedSource(request.audio))) {
      callback(new Error('Unsupported stream setup')); return;
    }
    const family = request.addressVersion === 'ipv4' ? 'udp4' : 'udp6';
    const bindAddress = family === 'udp4' ? '0.0.0.0' : '::';
    const video = {socket: createSocket(family), ssrc: CameraController.generateSynchronisationSource()};
    const audio = this.camera.audio ? {socket: createSocket(family), ssrc: CameraController.generateSynchronisationSource()} : undefined;
    const audioInput = audio && createSocket('udp4');
    const session: Session = {request, video, audio, audioInput, videoReleased: false,
      cancelPrepare: () => callback(new Error('Stream setup cancelled'))};
    this.sessions.set(request.sessionID, session);
    const bindings: Array<[Socket, string]> = [[video.socket, bindAddress]];
    if (audio && audioInput) bindings.push([audio.socket, bindAddress], [audioInput, '127.0.0.1']);
    let remaining = bindings.length;
    const failed = () => {
      if (this.sessions.get(request.sessionID) !== session) return;
      if (session.cancelPrepare) {
        session.cancelPrepare = undefined;
        this.stop(request.sessionID);
        callback(new Error('Unable to reserve stream port'));
      } else {
        this.stop(request.sessionID);
        this.controller?.forceStopStreamingSession(request.sessionID);
      }
    };
    for (const [socket, address] of bindings) {
      socket.on('error', failed);
      socket.bind(0, address, () => {
        if (this.sessions.get(request.sessionID) !== session || --remaining !== 0) return;
        session.cancelPrepare = undefined;
        const response = {video: endpointResponse(video, request.video),
          audio: audio && endpointResponse(audio, request.audio)};
        callback(undefined, response);
      });
    }
    if (this.sessions.get(request.sessionID) === session) {
      session.timer = setTimeout(() => this.stop(request.sessionID), 15000);
    }
  }
  handleStreamRequest(request: StreamingRequest, callback: StreamRequestCallback) {
    this.log(request.type, request.type === 'stop' ? {} : {video: request.video,
      audio: request.type === 'start' && this.camera.audio
        ? {codec: request.audio.codec, sampleRate: request.audio.sample_rate, packetTime: request.audio.packet_time,
          channels: request.audio.channel, bitrate: request.audio.max_bit_rate} : undefined});
    if (request.type === 'stop') { this.stop(request.sessionID); callback(); return; }
    const session = this.sessions.get(request.sessionID);
    if (!this.enabled || !session || session.cancelPrepare) { callback(new Error('Unknown streaming session')); return; }
    if (request.type === 'reconfigure') {
      // Reject explicitly; silently accepting would leave the wrong format on the wire.
      callback(new Error('Live reconfiguration requires restarting the stream')); return;
    }
    if (session.child) { callback(new Error('Stream already started')); return; }
    const video = request.video; const destination = session.request;
    let args: string[];
    try {
      const host = destination.addressVersion === 'ipv6' ? '[' + destination.targetAddress + ']' : destination.targetAddress;
      const videoPort = session.video.socket.address().port;
      const videoUrl = `srtp://${host}:${destination.video.port}?rtcpport=${destination.video.port}&localrtcpport=${videoPort}&pkt_size=${Math.min(video.mtu, 1378)}`;
      const videoKey = Buffer.concat([destination.video.srtp_key, destination.video.srtp_salt]).toString('base64');
      const suite = 'AES_CM_128_HMAC_SHA1_80';
      args = [...inputArguments(this.camera, Boolean(session.audio)), '-progress', 'pipe:1',
        ...videoArguments(video.width, video.height, video.fps, video.max_bit_rate, video.profile, video.level, video.fps * 2)];
      if (session.audio && session.audioInput) {
        const audio = request.audio;
        const audioPort = session.audioInput.address().port;
        const videoOutput = `[select=v:f=rtp:payload_type=${video.pt}:ssrc=${session.video.ssrc}:srtp_out_suite=${suite}:srtp_out_params=${videoKey}]${videoUrl}`;
        const audioOutput = `[select=a:f=rtp:payload_type=${audio.pt}:ssrc=${session.audio.ssrc}:onfail=ignore]rtp://127.0.0.1:${audioPort}?rtcpport=${audioPort}&pkt_size=400`;
        args.push(...opusArguments(audio, this.microphoneVolume), '-max_interleave_delta', '500000', '-f', 'tee', videoOutput + '|' + audioOutput);
        forwardOpus(session.audioInput, session.audio.socket, destination.targetAddress, destination.audio, session.audio.ssrc,
          audio, () => this.microphoneMuted || this.microphoneVolume === 0);
      } else {
        args.push('-an', '-payload_type', String(video.pt), '-ssrc', String(session.video.ssrc), '-f', 'rtp',
          '-srtp_out_suite', suite, '-srtp_out_params', videoKey, videoUrl);
      }
    } catch { this.log('unsupported_configuration'); callback(new Error('Unsupported live stream configuration')); this.stop(request.sessionID); return; }
    clearTimeout(session.timer);
    session.video.socket.close(); session.videoReleased = true;
    const child = session.child = launch(args);
    let completed = false;
    const done = (error?: Error) => { if (!completed) { completed = true; callback(error); } };
    const failed = (reason: string) => { this.log('failed', {reason}); done(new Error('Live stream failed')); this.stop(request.sessionID); this.controller?.forceStopStreamingSession(request.sessionID); };
    session.timer = setTimeout(() => failed('startup_timeout'), 15000);
    let progress = '';
    child.stdout.on('data', chunk => {
      if (this.sessions.get(request.sessionID) !== session) return;
      progress = (progress + chunk.toString()).slice(-4096);
      if (/frame=\s*[1-9][0-9]*/.test(progress)) {
        if (!completed) this.log('sending_frames');
        clearTimeout(session.timer); session.timer = setTimeout(() => failed('frame_timeout'), 15000); done(); progress = '';
      }
    });
    child.once('error', () => failed('ffmpeg_unavailable'));
    child.once('close', code => { if (this.sessions.get(request.sessionID) === session) failed(`ffmpeg_exit_${code}`); });
  }
  private stop(id: string) {
    const session = this.sessions.get(id); if (!session) return;
    this.sessions.delete(id); clearTimeout(session.timer);
    for (const socket of [session.videoReleased ? undefined : session.video.socket, session.audio?.socket, session.audioInput]) {
      try { socket?.close(); } catch {}
    }
    if (session.child) terminate(session.child);
    session.cancelPrepare?.();
  }
  setMicrophone(muted: boolean, volume: number) {
    this.microphoneMuted = muted;
    const previousVolume = this.microphoneVolume;
    this.microphoneVolume = Math.max(0, Math.min(100, volume));
    if (this.microphoneVolume !== previousVolume && this.microphoneVolume > 0) {
      for (const [id, session] of this.sessions) if (session.audio && session.child) {
        this.stop(id);
        this.controller?.forceStopStreamingSession(id);
      }
    }
  }
  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    if (!enabled) { for (const id of this.sessions.keys()) { this.stop(id); this.controller?.forceStopStreamingSession(id); } for (const abort of this.snapshots) abort.abort(); }
  }
  close() { this.setEnabled(false); }
}
