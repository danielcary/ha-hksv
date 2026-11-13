import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { HAPStorage } from '@homebridge/hap-nodejs';
import { createApi } from './api.js';
import { shutdownMedia } from './ffmpeg.js';
import { CameraRuntime } from './runtime.js';
import { CameraStore } from './store.js';

async function main() {
  const directory = process.env.HKSV_DATA_DIR ?? '/data';
  let token = process.env.HKSV_API_TOKEN;
  if (!token) {
    const options = JSON.parse(await readFile(join(directory, 'options.json'), 'utf8'));
    token = options.api_token;
  }
  if (typeof token !== 'string' || token.length < 32) throw new Error('Configure an API token of at least 32 characters');
  const hapDirectory = join(directory, 'homekit');
  await mkdir(hapDirectory, {recursive: true, mode: 0o700});
  HAPStorage.setCustomStoragePath(hapDirectory);
  const store = new CameraStore(directory);
  await store.load();
  const runtime = new CameraRuntime(directory);
  for (const camera of store.all()) {
    try { await runtime.upsert(camera); } catch { console.error('A camera could not be published; check status API'); }
  }
  const server = createApi(store, token, runtime);
  server.listen(8099, process.env.HKSV_BIND_ADDRESS ?? '127.0.0.1', () => console.log('HKSV experimental engine listening on port 8099'));
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return; shuttingDown = true;
    server.close(); server.closeAllConnections();
    await runtime.close(); await shutdownMedia();
    process.exit(0);
  };
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, shutdown);
  server.on('error', () => { console.error('API listener failed'); void runtime.close().then(() => { process.exitCode = 1; }); });
}
main().catch(() => { console.error('Engine startup failed; check configuration and data directory permissions'); process.exitCode = 1; });
