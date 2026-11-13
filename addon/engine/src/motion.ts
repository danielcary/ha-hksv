import { ChildProcessWithoutNullStreams } from 'node:child_process';
import { CameraConfig } from './config.js';
import { inputArguments, launch, terminate } from './ffmpeg.js';

const WIDTH = 160;
const HEIGHT = 120;
const FPS = 5;
const FRAME_BYTES = WIDTH * HEIGHT;
const MIN_CHANGED_PIXELS = Math.ceil(FRAME_BYTES * 0.015);
const HOLD_FRAMES = FPS * 5;

// Ignore small pixel changes and uniform brightness shifts. Requiring two
// comparisons also filters isolated bad frames and most one-frame flashes.
function changed(previous: Buffer, current: Buffer): boolean {
  let totalShift = 0;
  for (let i = 0; i < FRAME_BYTES; i++) totalShift += current[i] - previous[i];
  const averageShift = totalShift / FRAME_BYTES;
  let pixels = 0;
  for (let i = 0; i < FRAME_BYTES; i++) {
    if (Math.abs(current[i] - previous[i] - averageShift) < 20) continue;
    if (++pixels >= MIN_CHANGED_PIXELS) return true;
  }
  return false;
}

export class FrameMotion {
  private previous = Buffer.alloc(FRAME_BYTES);
  private older = Buffer.alloc(FRAME_BYTES);
  private consecutive = 0;
  private hold = 0;
  private warming = FPS;

  update(frame: Buffer): boolean {
    if (this.warming > 0) {
      this.warming--;
    } else {
      this.consecutive = changed(this.previous, frame) ? Math.min(2, this.consecutive + 1) : 0;
      // When a frame flashes and returns to the previous scene, two adjacent
      // comparisons differ but the one across the flash does not.
      const sustained = this.consecutive >= 2 && changed(this.older, frame);
      if (sustained || (this.hold > 0 && this.consecutive > 0)) this.hold = HOLD_FRAMES;
      else this.hold = Math.max(0, this.hold - 1);
    }
    const scratch = this.older;
    this.older = this.previous;
    this.previous = scratch;
    frame.copy(this.previous);
    return this.hold > 0;
  }
}

export class MotionDetector {
  private child?: ChildProcessWithoutNullStreams;
  private watchdog?: NodeJS.Timeout;
  private retry?: NodeJS.Timeout;
  private enabled = false;
  private active = false;
  status: 'disabled' | 'starting' | 'watching' | 'retrying' = 'disabled';

  constructor(private camera: CameraConfig, private onMotion: (active: boolean) => void) {}

  setEnabled(enabled: boolean) {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (enabled) {
      this.start();
    } else {
      clearTimeout(this.retry);
      this.status = 'disabled';
      this.stop();
    }
  }

  private start() {
    this.status = 'starting';
    const child = this.child = launch([...inputArguments(this.camera), '-map', '0:v:0', '-an', '-sn', '-dn',
      '-vf', `fps=${FPS},scale=${WIDTH}:${HEIGHT}:flags=area,format=gray`, '-threads:v', '1',
      '-c:v', 'rawvideo', '-f', 'rawvideo', 'pipe:1']);
    const detector = new FrameMotion();
    const frame = Buffer.alloc(FRAME_BYTES);
    let offset = 0;
    const failed = () => {
      if (this.child !== child) return;
      this.status = 'retrying';
      this.stop();
      this.retry = setTimeout(() => this.start(), 5000);
    };
    this.watchdog = setTimeout(failed, 15000);
    child.stdout.on('data', (chunk: Buffer) => {
      if (this.child !== child) return;
      for (let start = 0; start < chunk.length;) {
        const bytes = chunk.copy(frame, offset, start, start + FRAME_BYTES - offset);
        start += bytes;
        offset += bytes;
        if (offset !== FRAME_BYTES) continue;
        offset = 0;
        if (this.status === 'starting') {
          this.status = 'watching';
          clearTimeout(this.watchdog);
          this.watchdog = setTimeout(failed, 5000);
        }
        this.watchdog?.refresh();
        this.update(detector.update(frame));
      }
    });
    child.once('error', failed);
    child.once('close', failed);
  }

  private update(active: boolean) {
    if (active === this.active) return;
    this.active = active;
    console.info(JSON.stringify({component: 'motion', camera: this.camera.id, active}));
    this.onMotion(active);
  }

  private stop() {
    clearTimeout(this.watchdog);
    const child = this.child;
    this.child = undefined;
    if (child) terminate(child);
    this.update(false);
  }
}
