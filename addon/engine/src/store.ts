import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CameraConfig, parseCamera } from './config.js';

export class CameraStore {
  private cameras = new Map<string, CameraConfig>();
  private motion = new Map<string, boolean>();
  private queue: Promise<void> = Promise.resolve();
  constructor(private directory: string) {}
  async load(): Promise<void> {
    await mkdir(this.directory, {recursive: true, mode: 0o700});
    try {
      const data: unknown = JSON.parse(await readFile(join(this.directory, 'cameras.json'), 'utf8'));
      if (!Array.isArray(data)) throw new Error('Invalid stored configuration');
      for (const item of data) { const camera = parseCamera(item); this.cameras.set(camera.id, camera); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  all(): CameraConfig[] { return [...this.cameras.values()].map(camera => ({...camera})); }
  list() {
    return [...this.cameras.values()].map(({id, name}) => ({id, name, motion: this.motion.get(id) ?? false, status: 'media_not_implemented'}));
  }
  put(camera: CameraConfig): Promise<void> {
    const operation = this.queue.then(async () => {
      const next = new Map(this.cameras);
      next.set(camera.id, camera);
      const file = join(this.directory, 'cameras.json');
      await writeFile(file + '.tmp', JSON.stringify([...next.values()]), {mode: 0o600});
      await rename(file + '.tmp', file);
      this.cameras = next;
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
  setMotion(id: string, active: boolean): boolean {
    if (!this.cameras.has(id)) return false;
    this.motion.set(id, active);
    return true;
  }
}
