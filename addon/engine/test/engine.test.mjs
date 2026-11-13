import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {CameraStore} from '../dist/store.js';
import {createApi} from '../dist/api.js';
import {FragmentBuffer} from '../dist/buffer.js';
import {parseCamera} from '../dist/config.js';
import {FrameMotion} from '../dist/motion.js';

test('configuration rejects invalid schemes and ids without echoing credentials', () => {
  for (const rtspUrl of ['file:///etc/passwd', 'http://secret:password@camera', 'bad']) {
    assert.throws(() => parseCamera({id:'front', name:'Front', rtspUrl}), /Invalid RTSP URL/);
  }
  assert.throws(() => parseCamera({id:'../x', name:'Front', rtspUrl:'rtsp://camera/live'}));
  assert.throws(() => parseCamera({id:'front', name:'Front', rtspUrl:'rtsp://camera/live', softwareMotion:'true'}), /Invalid motion setting/);
});
test('video motion ignores a light shift and a single bad frame, then clears after quiet', () => {
  const detector = new FrameMotion();
  const baseline = Buffer.alloc(160 * 120, 48);
  const brighter = Buffer.alloc(baseline.length, 105);
  const object = x => {
    const frame = Buffer.from(brighter);
    for (let row = 30; row < 60; row++) frame.fill(220, row * 160 + x, row * 160 + x + 30);
    return frame;
  };
  for (let i = 0; i < 6; i++) assert.equal(detector.update(baseline), false);
  assert.equal(detector.update(brighter), false);
  assert.equal(detector.update(object(0)), false);
  assert.equal(detector.update(brighter), false);
  assert.equal(detector.update(object(0)), false);
  assert.equal(detector.update(object(25)), true);
  for (let i = 0; i < 24; i++) assert.equal(detector.update(object(25)), true);
  assert.equal(detector.update(object(25)), false);
});
test('buffer covers boundary, caps memory, and protects snapshots', () => {
  const buffer = new FragmentBuffer(4000, 20);
  for (let t = 0; t <= 8000; t += 2000) buffer.push(Buffer.from(String(t)), t);
  assert.deepEqual(buffer.snapshot().map(b => b.toString()), ['4000', '6000', '8000']);
  buffer.snapshot()[0].fill(0);
  assert.equal(buffer.snapshot()[0].toString(), '4000');
  assert.throws(() => buffer.push(Buffer.from('x'), 100));
  assert.throws(() => buffer.push(Buffer.alloc(21), 9000));
  const bounded = new FragmentBuffer(4000, 4);
  bounded.push(Buffer.from('abc'), 0); bounded.push(Buffer.from('def'), 1);
  assert.deepEqual(bounded.snapshot().map(b => b.toString()), ['def']);
});
test('authenticated API persists cameras, hides secrets, validates and tracks motion', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'hksv-test-'));
  t.after(() => rm(directory, {recursive:true, force:true}));
  const store = new CameraStore(directory); await store.load();
  const token = 'a'.repeat(32);
  const server = createApi(store, token); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => {server.close(resolve); server.closeAllConnections();}));
  const url = `http://127.0.0.1:${server.address().port}`;
  const headers = {Authorization:`Bearer ${token}`, 'Content-Type':'application/json'};
  assert.equal((await fetch(url + '/v1/status')).status, 401);
  const camera = {id:'front', name:'Front', rtspUrl:'rtsp://user:secret@camera/live'};
  assert.equal((await fetch(url + '/v1/cameras', {method:'POST', headers, body:JSON.stringify(camera)})).status, 200);
  const reloaded = new CameraStore(directory); await reloaded.load(); assert.equal(reloaded.list()[0].id, 'front');
  assert.equal((await stat(join(directory,'cameras.json'))).mode & 0o777, 0o600);
  assert.equal((await fetch(url + '/v1/cameras/front/motion', {method:'POST', headers, body:'{"active":true}'})).status, 200);
  const response = await fetch(url + '/v1/status', {headers}); const data = await response.json();
  assert.equal(data.cameras[0].motion, true); assert.equal(data.capabilities.hksv, false);
  assert.ok(!JSON.stringify(data).includes('secret')); assert.ok(!JSON.stringify(data).includes('rtsp'));
  assert.equal((await fetch(url + '/v1/cameras/front/motion', {method:'POST', headers, body:'{"active":"true"}'})).status, 400);
  assert.equal((await fetch(url + '/v1/cameras/missing/motion', {method:'POST', headers, body:'{"active":true}'})).status, 404);
  assert.equal((await fetch(url + '/v1/cameras', {method:'POST', headers, body:'x'.repeat(17000)})).status, 400);
});
