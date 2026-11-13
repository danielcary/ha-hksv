import { join } from 'node:path';
import { CameraConfig } from './config.js';
import { HomeKitCamera } from './camera.js';
import { loadIdentity } from './identity.js';

export class CameraRuntime {
  private cameras = new Map<string, HomeKitCamera>();
  private errors = new Set<string>();
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  constructor(private directory: string) {}
  upsert(config: CameraConfig): Promise<void> {
    const operation = this.queue.then(async () => {
      if (this.closed) throw new Error('Engine shutting down');
      const previous = this.cameras.get(config.id);
      if (previous && JSON.stringify(previous.config) === JSON.stringify(config)) return;
      if (previous) { await previous.close(); this.cameras.delete(config.id); }
      let camera: HomeKitCamera | undefined;
      try {
        const identity = await loadIdentity(join(this.directory, 'identities'), config.id);
        camera = new HomeKitCamera(config, identity);
        await camera.publish(); this.cameras.set(config.id, camera); this.errors.delete(config.id);
      } catch {
        await camera?.close().catch(() => {}); this.errors.add(config.id);
        throw new Error('Camera publication failed');
      }
    });
    this.queue = operation.catch(() => {}); return operation;
  }
  motion(id: string, active: boolean) { this.cameras.get(id)?.setMotion(active); }
  status(id: string) { return this.cameras.get(id)?.status() ?? {status: this.errors.has(id) ? 'publication_error' : 'not_published'}; }
  pairing(id: string) { return this.cameras.get(id)?.pairing(); }
  async close() {
    this.closed = true; await this.queue;
    await Promise.allSettled([...this.cameras.values()].map(camera => camera.close())); this.cameras.clear();
  }
}
