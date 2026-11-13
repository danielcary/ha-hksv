import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {once} from 'node:events';

test('engine publishes test camera, exposes authenticated pairing QR, and restores identity after restart', {skip: !process.env.HKSV_REQUIRE_FFMPEG, timeout:20000}, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'hksv-runtime-'));
  t.after(() => rm(directory, {recursive:true, force:true}));
  await writeFile(join(directory,'cameras.json'), JSON.stringify([{id:'test',name:'Test Camera',rtspUrl:'test://pattern'}]), {mode:0o600});
  const token = 'test-only-'.repeat(4);
  const headers = {Authorization:`Bearer ${token}`};
  let child;
  async function start() {
    child = spawn(process.execPath, ['dist/index.js'], {env:{...process.env, HKSV_DATA_DIR:directory, HKSV_API_TOKEN:token}, stdio:'ignore'});
    for (let i=0; i<100; i++) {
      if (child.exitCode !== null) throw new Error('Engine exited during startup');
      try { const response = await fetch('http://127.0.0.1:8099/v1/status', {headers}); if (response.ok) return response.json(); } catch {}
      await delay(50);
    }
    throw new Error('Engine did not start');
  }
  async function stop() {
    if (!child || child.exitCode !== null) return;
    const exit = once(child, 'exit'); child.kill('SIGTERM');
    const timeout = setTimeout(() => child.kill('SIGKILL'), 3000);
    const [code] = await exit; clearTimeout(timeout); assert.equal(code, 0);
  }
  t.after(stop);
  const status = await start();
  assert.equal(status.cameras[0].status, 'published'); assert.equal(status.capabilities.hksv, true);
  assert.equal((await fetch('http://127.0.0.1:8099/v1/cameras/test/pairing')).status, 401);
  const getPairing = async () => (await fetch('http://127.0.0.1:8099/v1/cameras/test/pairing', {headers})).json();
  const pairing = await getPairing();
  assert.match(pairing.pincode, /^\d{3}-\d{2}-\d{3}$/); assert.match(pairing.setupUri, /^X-HM:\/\//); assert.match(pairing.qrSvg, /<svg/);
  await stop(); await start();
  assert.deepEqual(await getPairing(), pairing);
});
