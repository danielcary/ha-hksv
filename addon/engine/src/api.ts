import QRCode from 'qrcode';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { CameraStore } from './store.js';
import { CameraRuntime } from './runtime.js';
import { parseCamera } from './config.js';

function reply(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'});
  res.end(JSON.stringify(body));
}
async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16384) throw new Error('Body too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export function createApi(store: CameraStore, token: string, runtime?: CameraRuntime) {
  if (token.length < 32) throw new Error('API token must be at least 32 characters');
  const expected = Buffer.from(`Bearer ${token}`);
  const server = createServer(async (req, res) => {
    const supplied = Buffer.from(req.headers.authorization ?? '');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      reply(res, 401, {error: 'Unauthorized'}); return;
    }
    try {
      if (req.method === 'GET' && req.url === '/v1/status') {
        reply(res, 200, {version: '0.2.0', capabilities: {configuration: true, motionInput: true, softwareMotion: Boolean(runtime), liveVideo: Boolean(runtime), hksv: Boolean(runtime), onvif: false, testSource: true}, validation: 'experimental_single_camera_trial_passed', cameras: store.list().map(camera => ({...camera, ...(runtime?.status(camera.id) ?? {})}))});
      } else if (req.method === 'POST' && req.url === '/v1/cameras') {
        let camera;
        try { camera = parseCamera(await body(req)); } catch { reply(res, 400, {error: 'Invalid camera configuration'}); return; }
        await store.put(camera);
        await runtime?.upsert(camera);
        reply(res, 200, {id: camera.id});
      } else if (req.method === 'GET' && /^\/v1\/cameras\/[a-z0-9_-]+\/pairing$/.test(req.url ?? '')) {
        const pairing = runtime?.pairing(req.url!.split('/')[3]);
        reply(res, pairing ? 200 : 404, pairing ? {...pairing, qrSvg: pairing.setupUri ? await QRCode.toString(pairing.setupUri, {type: 'svg'}) : undefined} : {error: 'Camera not published'});
      } else if (req.method === 'POST' && /^\/v1\/cameras\/[a-z0-9_-]+\/motion$/.test(req.url ?? '')) {
        let data;
        try { data = await body(req) as {active?: unknown}; } catch { reply(res, 400, {error: 'Invalid JSON'}); return; }
        if (!data || typeof data.active !== 'boolean') { reply(res, 400, {error: 'active must be boolean'}); return; }
        const id = req.url!.split('/')[3];
        const found = store.setMotion(id, data.active);
        if (found) runtime?.motion(id, data.active);
        reply(res, found ? 200 : 404, {id});
      } else { reply(res, 404, {error: 'Not found'}); }
    } catch { reply(res, 500, {error: 'Internal error'}); }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  return server;
}
