import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { CameraConfig } from './config.js';

const children = new Set<ChildProcessWithoutNullStreams>();
export const ffmpegPath = () => process.env.HKSV_FFMPEG_PATH ?? 'ffmpeg';
export function inputArguments(camera: CameraConfig, audio = false): string[] {
  const pattern = 'testsrc2=size=1280x720:rate=30';
  return camera.rtspUrl === 'test://pattern'
    ? ['-re', '-f', 'lavfi', '-i', audio
      ? pattern + '[out0];sine=frequency=440:sample_rate=48000[out1]' : pattern]
    : ['-rtsp_transport', 'tcp', '-timeout', '10000000', '-i', camera.rtspUrl];
}
export function videoArguments(width: number, height: number, fps: number, bitrate: number, profile: number, level: number, gop: number): string[] {
  if (![width, height, fps, bitrate, gop].every(n => Number.isFinite(n) && n > 0)
      || width > 1920 || height > 1080 || fps > 30 || bitrate > 10000
      || ![0, 1, 2].includes(profile) || ![0, 1, 2].includes(level)) throw new Error('Unsupported video configuration');
  return ['-map', '0:v:0', '-sn', '-dn', '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
    // zerolatency enables sliced threads; automatic CPU counts can exceed Apple's
    // slice limit. Use frame threads and one slice regardless of host core count.
    '-threads', '2', '-x264-params', 'sliced-threads=0:slices=1',
    '-pix_fmt', 'yuv420p', '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
    '-r', String(fps), '-b:v', `${bitrate}k`, '-maxrate', `${bitrate}k`, '-bufsize', `${bitrate * 2}k`,
    '-profile:v', ['baseline', 'main', 'high'][profile], '-level:v', ['3.1', '3.2', '4.0'][level],
    '-g', String(gop), '-keyint_min', String(gop), '-sc_threshold', '0', '-bf', '0'];
}
/** Never log arguments/stderr: camera passwords and SRTP keys can occur in both. */
export function launch(args: string[]): ChildProcessWithoutNullStreams {
  const child = spawn(ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-nostdin', ...args], {stdio: 'pipe'});
  children.add(child); child.once('close', () => children.delete(child));
  child.stdin.end();
  child.stderr.resume();
  return child;
}
export function terminate(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
  timer.unref(); child.once('close', () => clearTimeout(timer));
}
export async function snapshot(camera: CameraConfig, width: number, height: number, signal?: AbortSignal): Promise<Buffer> {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 1920 || height > 1080) throw new Error('Invalid snapshot size');
  return new Promise((resolve, reject) => {
    const child = launch([...inputArguments(camera), '-frames:v', '1', '-an', '-vf', `scale=${width}:${height}`, '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1']);
    const chunks: Buffer[] = []; let size = 0; let settled = false;
    const done = (error?: Error) => {
      if (settled) return; settled = true;
      clearTimeout(timer); signal?.removeEventListener('abort', abort); terminate(child);
      if (error) reject(error); else resolve(Buffer.concat(chunks));
    };
    const abort = () => done(new Error('Snapshot cancelled'));
    const timer = setTimeout(() => done(new Error('Snapshot timed out')), 10000);
    signal?.addEventListener('abort', abort, {once: true});
    child.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 4 * 1024 * 1024) done(new Error('Snapshot too large')); else chunks.push(chunk); });
    child.once('error', () => done(new Error('FFmpeg unavailable')));
    child.once('close', code => done(code === 0 && size ? undefined : new Error('Snapshot failed')));
    if (signal?.aborted) abort();
  });
}

export async function shutdownMedia(): Promise<void> {
  await Promise.all([...children].map(child => new Promise<void>(resolve => {
    child.once('close', () => resolve()); terminate(child);
  })));
}
