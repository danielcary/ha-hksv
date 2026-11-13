import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {once} from 'node:events';
import {createConnection} from 'node:net';
import {HomeKitCamera} from '../dist/camera.js';
import {loadIdentity} from '../dist/identity.js';
import {snapshot} from '../dist/ffmpeg.js';
import {Characteristic, HAPStorage} from '@homebridge/hap-nodejs';

const available = spawnSync('mediamtx', ['--version']).status === 0;
if (process.env.HKSV_REQUIRE_FFMPEG && !available) throw new Error('RTSP fixture missing');
test('RTSP camera video triggers motion, a HomeKit sensor event, and a recording', {skip:!available, timeout:45000}, async t => {
  const dir = await mkdtemp(join(tmpdir(),'hksv-rtsp-')); t.after(() => rm(dir,{recursive:true,force:true}));
  const file = join(dir,'mediamtx.yml');
  await writeFile(file, 'logLevel: info\nrtspAddress: 127.0.0.1:8554\nrtspTransports: [tcp]\nrtmp: false\nhls: false\nwebrtc: false\nsrt: false\nmoq: false\npaths:\n  all_others:\n');
  const server = spawn('mediamtx',[file],{stdio:['ignore','pipe','pipe']});
  let logs = ''; for (const output of [server.stdout,server.stderr]) output.on('data', b => { logs = (logs + b.toString()).slice(-10000); });
  async function stop(child) { if (child.exitCode !== null || child.signalCode !== null) return; const exit = once(child,'exit'); child.kill('SIGTERM'); const timer = setTimeout(() => child.kill('SIGKILL'),2000); await exit; clearTimeout(timer); }
  t.after(() => stop(server));
  async function waitFor(predicate) { for (let i=0;i<240;i++) { if (await predicate()) return; await delay(50); } throw new Error('RTSP fixture timed out: ' + logs); }
  await waitFor(() => new Promise(resolve => {
    const socket = createConnection({host:'127.0.0.1',port:8554});
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => { socket.destroy(); resolve(false); });
  }));
  const url = 'rtsp://127.0.0.1:8554/camera';
  // Start with a still scene, then move a high-contrast object through it.
  const scene = 'color=c=gray:s=640x360:r=15[bg];color=c=white:s=128x128:r=15[box];'
    + "[bg][box]overlay=x='mod(t*250,512)':y=100:enable='gte(t,8)'";
  const publisher = spawn('ffmpeg',['-v','error','-nostdin','-re','-f','lavfi','-i',scene,'-c:v','libx264','-preset','ultrafast','-tune','zerolatency','-g','30','-an','-f','rtsp','-rtsp_transport','tcp',url],{stdio:'ignore'});
  t.after(() => stop(publisher));
  await waitFor(() => logs.includes('publishing'));
  HAPStorage.setCustomStoragePath(dir);
  const config = {id:'rtsp',name:'RTSP Fixture',rtspUrl:url,softwareMotion:true};
  const camera = new HomeKitCamera(config, await loadIdentity(join(dir,'identities'),config.id));
  t.after(() => camera.close());
  await camera.publish();
  const recording = camera.recording;
  const motion = camera.controller.motionService.getCharacteristic(Characteristic.MotionDetected);
  recording.updateRecordingConfiguration({prebufferLength:4000,eventTriggerTypes:[1],mediaContainerConfiguration:{type:0,fragmentLength:4000},videoCodec:{type:0,parameters:{profile:0,level:0,bitRate:300,iFrameInterval:2000},resolution:[640,360,15]},audioCodec:{type:0,audioChannels:1,bitrateMode:0,samplerate:5,bitrate:32}});
  recording.updateRecordingActive(true);
  await waitFor(() => camera.status().motionDetector === 'watching');
  assert.equal(motion.value, false);
  const jpeg = await snapshot(config,320,240); assert.equal(jpeg.readUInt16BE(0),0xffd8);
  await waitFor(() => motion.value === true);
  assert.equal(camera.status().motion, true);
  const stream = recording.handleRecordingStreamRequest(20);
  const init = await stream.next(), fragment = await stream.next();
  assert.ok(init.value.data.includes(Buffer.from('moov'))); assert.ok(fragment.value.data.includes(Buffer.from('mdat')));
  await stream.return();
  camera.controller.recordingManagement.operatingModeService.updateCharacteristic(Characteristic.HomeKitCameraActive,false);
  assert.equal(camera.status().motionDetector, 'disabled');
  assert.equal(motion.value, false);
});
