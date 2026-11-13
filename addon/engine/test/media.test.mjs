import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn, spawnSync, execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {FragmentParser, FragmentTimeline} from '../dist/mp4.js';
import {snapshot, inputArguments, videoArguments} from '../dist/ffmpeg.js';
import {RecordingDelegate, recordingArguments} from '../dist/recording.js';
import {StreamingDelegate} from '../dist/streaming.js';
import {loadIdentity} from '../dist/identity.js';
import {HomeKitCamera} from '../dist/camera.js';
import {HAPStorage, Characteristic, decodeWithLists} from '@homebridge/hap-nodejs';
import {createSocket} from 'node:dgram';
import {once} from 'node:events';

const camera = {id:'test', name:'Test Camera', rtspUrl:'test://pattern'};
const configuration = {
  prebufferLength:4000, eventTriggerTypes:[1], mediaContainerConfiguration:{type:0, fragmentLength:4000},
  videoCodec:{type:0, parameters:{profile:0, level:0, bitRate:300, iFrameInterval:2000}, resolution:[640,360,15]},
  audioCodec:{type:0, audioChannels:1, bitrateMode:0, samplerate:5, bitrate:32},
};
const hasFFmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
if (process.env.HKSV_REQUIRE_FFMPEG && !hasFFmpeg) throw new Error('FFmpeg is required for container tests');
const mediaTest = (name, fn) => test(name, {skip: !hasFFmpeg, timeout: 35000}, fn);
const run = promisify(execFile);
async function waitFor(predicate, timeout = 12000) {
  const end = Date.now() + timeout;
  while (!predicate()) { if (Date.now() > end) throw new Error('Timed out waiting for media'); await delay(50); }
}
async function temporary(t) {
  const dir = await mkdtemp(join(tmpdir(), 'hksv-media-'));
  t.after(() => rm(dir, {recursive:true, force:true})); return dir;
}
function box(type, data = Buffer.alloc(0)) {
  const header = Buffer.alloc(8); header.writeUInt32BE(data.length + 8); header.write(type, 4); return Buffer.concat([header, data]);
}

test('MP4 parser handles arbitrary boundaries, extended sizes, and rejects truncation', () => {
  const init = []; const fragments = [];
  const parser = new FragmentParser(b => init.push(b), b => fragments.push(b));
  const stream = Buffer.concat([box('ftyp'), box('moov'), box('moof'), box('mdat', Buffer.from('abc'))]);
  for (const byte of stream) parser.push(Buffer.from([byte]));
  parser.finish(); assert.equal(init.length, 1); assert.equal(fragments.length, 1);
  assert.equal(fragments[0].subarray(-3).toString(), 'abc');
  const extended = Buffer.alloc(16); extended.writeUInt32BE(1); extended.write('ftyp', 4); extended.writeBigUInt64BE(16n, 8);
  const ext = new FragmentParser(() => {}, () => {}); ext.push(extended); ext.push(box('moov')); ext.finish();
  assert.throws(() => new FragmentParser(() => {}, () => {}).push(Buffer.alloc(8)), /size/);
  const truncated = new FragmentParser(() => {}, () => {}); truncated.push(stream.subarray(0, -1)); assert.throws(() => truncated.finish(), /Truncated/);
  const oversized = Buffer.alloc(8); oversized.writeUInt32BE(0x7fffffff);
  assert.throws(() => new FragmentParser(() => {}, () => {}).push(oversized), /size/);
});
test('recording arguments respect privacy and negotiated dimensions without shell parsing', () => {
  const secretCamera = {...camera, rtspUrl:'rtsp://user:p%24ss@camera/live'};
  const args = recordingArguments(secretCamera, configuration, false);
  assert.ok(args.includes(secretCamera.rtspUrl)); assert.ok(args.includes('-an'));
  assert.ok(!args.includes('anullsrc=channel_layout=mono:sample_rate=48000'));
  assert.ok(recordingArguments(camera, configuration, true).includes('aac'));
  assert.throws(() => recordingArguments(camera, {...configuration, videoCodec:{...configuration.videoCodec, resolution:[9999,360,15]}}, false));
});
test('clip clocks preserve audio offsets, support both tfdt versions and leave shared buffers intact', () => {
  function track(id, scale) {
    const tkhd = Buffer.alloc(16); tkhd.writeUInt32BE(id, 12);
    const mdhd = Buffer.alloc(16); mdhd.writeUInt32BE(scale, 12);
    return box('trak', Buffer.concat([box('tkhd', tkhd), box('mdia', box('mdhd', mdhd))]));
  }
  const init = box('moov', Buffer.concat([track(1,1000),track(2,48000)]));
  function fragment(videoTime, audioTime) {
    const mfhd = Buffer.alloc(8); mfhd.writeUInt32BE(99, 4);
    const tracks = [videoTime,audioTime].map((time,i) => {
      const tfhd = Buffer.alloc(8); tfhd.writeUInt32BE(i+1,4);
      const tfdt = Buffer.alloc(i ? 12 : 8); tfdt[0] = i;
      if (i) tfdt.writeBigUInt64BE(BigInt(time),4); else tfdt.writeUInt32BE(time,4);
      return box('traf',Buffer.concat([box('tfhd',tfhd),box('tfdt',tfdt)]));
    });
    return Buffer.concat([box('moof',Buffer.concat([box('mfhd',mfhd),...tracks])),box('mdat')]);
  }
  function times(data) {
    const first = data.indexOf('tfdt'), second = data.indexOf('tfdt', first+4);
    return [data.readUInt32BE(first+8),Number(data.readBigUInt64BE(second+8))];
  }
  const timeline = new FragmentTimeline(init), original = fragment(100000,4800480), copy = Buffer.from(original);
  assert.deepEqual(times(timeline.rebase(original)),[0,480]);
  assert.deepEqual(original,copy);
  const next = timeline.rebase(fragment(102000,4896480));
  assert.deepEqual(times(next),[2000,96480]);
  assert.equal(next.readUInt32BE(next.indexOf('mfhd')+8),2);
  assert.deepEqual(times(new FragmentTimeline(init).rebase(fragment(102000,4896480))),[0,480]);
  assert.throws(() => timeline.rebase(original.subarray(0,-1)), /MP4/);
  assert.throws(() => timeline.rebase(fragment(99000,4800480)), /precedes/);
});
test('pairing identity persists and accessory exposes recording, streaming and motion services', async t => {
  const dir = await temporary(t); HAPStorage.setCustomStoragePath(join(dir, 'hap'));
  const identity = await loadIdentity(dir, 'front');
  assert.deepEqual(await loadIdentity(dir, 'front'), identity);
  assert.equal((await stat(join(dir,'front.json'))).mode & 0o777, 0o600);
  const accessory = new HomeKitCamera(camera, identity); t.after(() => accessory.close());
  assert.ok(accessory.controller.recordingManagement);
  assert.equal(accessory.accessory.services.filter(s => s.UUID === '00000110-0000-1000-8000-0026BB765291').length, 2);
  assert.equal(accessory.accessory.services.filter(s => s.UUID === '00000204-0000-1000-8000-0026BB765291').length, 1);
  accessory.setMotion(true);
  assert.equal(accessory.controller.motionService.getCharacteristic(Characteristic.MotionDetected).value, true);
});
test('a 720p camera offers only 720p and smaller for live view and recording', async t => {
  const dir = await temporary(t);
  const identity = await loadIdentity(dir, 'quality');
  const cameraWithLimit = new HomeKitCamera({...camera, maxResolution:'720p'}, identity);
  t.after(() => cameraWithLimit.close());
  const values = [
    cameraWithLimit.controller.recordingManagement.recordingManagementService
      .getCharacteristic(Characteristic.SupportedVideoRecordingConfiguration).value,
    ...cameraWithLimit.accessory.services
      .filter(service => service.testCharacteristic(Characteristic.SupportedVideoStreamConfiguration))
      .map(service => service.getCharacteristic(Characteristic.SupportedVideoStreamConfiguration).value),
  ];
  assert.equal(values.length, 3);
  for (const value of values) {
    const codec = decodeWithLists(Buffer.from(value, 'base64'))[1];
    const attributes = decodeWithLists(codec)[3];
    assert.deepEqual(attributes.map(attribute => decodeWithLists(attribute)[2].readUInt16LE()), [720,720,360,360,240]);
  }
});
mediaTest('generated source produces a real JPEG snapshot', async () => {
  const jpeg = await snapshot(camera, 320, 240);
  assert.equal(jpeg.readUInt16BE(0), 0xffd8); assert.equal(jpeg.readUInt16BE(jpeg.length - 2), 0xffd9);
});
mediaTest('HomeKit video has one H.264 slice per frame independent of encoder thread defaults', async () => {
  const {stdout} = await run('ffmpeg', ['-v','error', ...inputArguments(camera),
    ...videoArguments(1280,720,30,299,2,2,60), '-frames:v','3','-an',
    '-bsf:v','h264_metadata=aud=insert','-f','h264','pipe:1'], {encoding:'buffer', timeout:10000});
  const frames = []; let slices = 0;
  for (let i = 0; i < stdout.length - 3; i++) {
    if (stdout[i] !== 0 || stdout[i + 1] !== 0 || stdout[i + 2] !== 1) continue;
    const type = stdout[i + 3] & 31;
    if (type === 9 && slices) { frames.push(slices); slices = 0; }
    if (type === 1 || type === 5) slices++;
    i += 2;
  }
  if (slices) frames.push(slices);
  assert.deepEqual(frames, [1,1,1], 'Apple rejects frames containing too many H.264 slices');
});
mediaTest('recording delivers decodable prebuffer and post-motion fMP4, then ends', async t => {
  const dir = await temporary(t);
  const recording = new RecordingDelegate(camera); t.after(() => recording.close());
  recording.updateRecordingConfiguration(configuration); recording.updateRecordingActive(true);
  await waitFor(() => recording.status === 'ready'); await delay(4300);
  recording.setMotion(true);
  // Delayed hub request must not lose the event's prebuffer.
  await delay(800);
  const stream = recording.handleRecordingStreamRequest(1);
  const packets = []; recording.setMotion(false);
  for await (const packet of stream) { packets.push(packet); if (packets.length > 20) throw new Error('Recording did not end'); }
  assert.ok(packets.length >= 5, `Only ${packets.length} packets`);
  assert.equal(packets.at(-1).isLast, true);
  const file = join(dir, 'recording.mp4'); await writeFile(file, Buffer.concat(packets.map(p => p.data)));
  const {stdout} = await run('ffprobe', ['-v','error','-show_streams','-show_packets','-of','json',file]);
  const metadata = JSON.parse(stdout);
  assert.equal(metadata.streams.length, 1); assert.equal(metadata.streams[0].codec_name, 'h264');
  assert.equal(metadata.streams[0].width, 640); assert.equal(metadata.streams[0].height, 360);
  const keyframes = metadata.packets.filter(p => p.flags.includes('K'));
  assert.ok(keyframes.length >= 4);
  const first = Number(metadata.packets[0].pts_time), last = Number(metadata.packets.at(-1).pts_time);
  assert.ok(first >= 0 && first < 0.001, `Clip starts at ${first} rather than zero`);
  assert.ok(last - first >= 8, `Recording only ${last-first} seconds`);
  for (let i = 1; i < packets.length; i++) {
    const fragment = join(dir, `fragment-${i}.mp4`);
    await writeFile(fragment, Buffer.concat([packets[0].data, packets[i].data]));
    await run('ffmpeg', ['-v','error','-i',fragment,'-frames:v','1','-f','null','-'], {timeout:5000});
  }
  await run('ffmpeg', ['-v','error','-i',file,'-f','null','-'], {timeout:5000});
  recording.updateRecordingActive(false); assert.equal(recording.status, 'disabled');
});
mediaTest('recording cancellation wakes a waiting consumer and privacy disables capture', async t => {
  const recording = new RecordingDelegate(camera); t.after(() => recording.close());
  recording.updateRecordingConfiguration(configuration); recording.updateRecordingActive(true);
  await waitFor(() => recording.status === 'ready'); recording.setMotion(true);
  const abort = new AbortController(); const stream = recording.handleRecordingStreamRequest(2, abort.signal);
  await stream.next(); await stream.next(); const waiting = stream.next(); abort.abort();
  assert.equal((await waiting).done, true);
  recording.setEnabled(false); assert.equal(recording.status, 'disabled');
  await assert.rejects(recording.handleRecordingStreamRequest(3).next(), /No recording/);
});
mediaTest('live stream sends SRTP packets and stops its FFmpeg process', async t => {
  const receiver = createSocket('udp4'); receiver.bind(0, '127.0.0.1'); await once(receiver, 'listening');
  t.after(() => receiver.close());
  const delegate = new StreamingDelegate(camera); t.after(() => delegate.close());
  const source = {port:receiver.address().port, srtpCryptoSuite:0, srtp_key:Buffer.alloc(16, 1), srtp_salt:Buffer.alloc(14, 2)};
  const prepared = await new Promise((resolve, reject) => delegate.prepareStream({sessionID:'live', sourceAddress:'127.0.0.1', targetAddress:'127.0.0.1', addressVersion:'ipv4', video:source, audio:source}, (e,r) => e ? reject(e) : resolve(r)));
  const packets = []; receiver.on('message', data => packets.push(data));
  await new Promise((resolve, reject) => delegate.handleStreamRequest({type:'start', sessionID:'live', video:{width:320,height:240,fps:15,max_bit_rate:200,profile:0,level:0,pt:99,mtu:1200,rtcp_interval:0.5}, audio:{}}, e => e ? reject(e) : resolve()));
  await waitFor(() => packets.some(p => (p[1] & 127) === 99));
  const packet = packets.find(p => (p[1] & 127) === 99);
  assert.equal(packet[0] >> 6, 2); assert.equal(packet.readUInt32BE(8), prepared.video.ssrc);
  await new Promise(resolve => delegate.handleStreamRequest({type:'stop',sessionID:'live'}, resolve));
});
mediaTest('two live viewers receive independent streams and stopping one preserves the other', async t => {
  const delegate = new StreamingDelegate(camera); t.after(() => delegate.close());
  const viewers = [];
  for (let i = 0; i < 2; i++) {
    const receiver = createSocket('udp4'); receiver.bind(0, '127.0.0.1'); await once(receiver, 'listening');
    t.after(() => receiver.close());
    const source = {port:receiver.address().port, srtpCryptoSuite:0, srtp_key:Buffer.alloc(16, i + 1), srtp_salt:Buffer.alloc(14, i + 2)};
    const request = {sessionID:`viewer-${i}`, sourceAddress:'127.0.0.1', targetAddress:'127.0.0.1', addressVersion:'ipv4', video:source, audio:source};
    const prepared = await new Promise((resolve, reject) => delegate.prepareStream(request, (e,r) => e ? reject(e) : resolve(r)));
    const viewer = {request, prepared, packets:0}; viewers.push(viewer);
    receiver.on('message', data => { if ((data[1] & 127) === 99) viewer.packets++; });
    await new Promise((resolve, reject) => delegate.handleStreamRequest({type:'start', sessionID:request.sessionID,
      video:{width:320,height:240,fps:15,max_bit_rate:200,profile:0,level:0,pt:99,mtu:1200,rtcp_interval:0.5},audio:{}}, e => e ? reject(e) : resolve()));
  }
  assert.notEqual(viewers[0].prepared.video.port, viewers[1].prepared.video.port);
  await waitFor(() => viewers.every(viewer => viewer.packets > 0));
  await assert.rejects(new Promise((resolve, reject) => delegate.prepareStream({...viewers[0].request, sessionID:'third'}, e => e ? reject(e) : resolve())), /Unsupported stream setup/);
  await new Promise(resolve => delegate.handleStreamRequest({type:'stop', sessionID:viewers[0].request.sessionID}, resolve));
  const previous = viewers[1].packets;
  await waitFor(() => viewers[1].packets > previous + 5);
});
mediaTest('enabled recording audio supplies AAC silence and privacy changes clear buffered audio', async t => {
  const dir = await temporary(t);
  const recording = new RecordingDelegate(camera); t.after(() => recording.close());
  recording.setAudioActive(true); recording.updateRecordingConfiguration(configuration); recording.updateRecordingActive(true);
  await waitFor(() => recording.status === 'ready'); recording.setMotion(true);
  const stream = recording.handleRecordingStreamRequest(10);
  const init = await stream.next(); const fragment = await stream.next();
  const file = join(dir,'audio.mp4'); await writeFile(file, Buffer.concat([init.value.data, fragment.value.data]));
  const {stdout} = await run('ffprobe', ['-v','error','-show_streams','-of','json',file]);
  assert.deepEqual(JSON.parse(stdout).streams.map(s => s.codec_name), ['h264','aac']);
  recording.setAudioActive(false);
  assert.equal((await stream.next()).done, true);
  await waitFor(() => recording.status === 'ready');
  recording.setMotion(false); recording.setMotion(true);
  const silent = recording.handleRecordingStreamRequest(11);
  const nextInit = await silent.next(); const nextFragment = await silent.next();
  const nextFile = join(dir,'no-audio.mp4'); await writeFile(nextFile, Buffer.concat([nextInit.value.data,nextFragment.value.data]));
  const result = await run('ffprobe', ['-v','error','-show_streams','-of','json',nextFile]);
  assert.deepEqual(JSON.parse(result.stdout).streams.map(s => s.codec_name), ['h264']);
  await silent.return();
});
mediaTest('recording encodes source audio and removes it when recording audio is disabled', async t => {
  const dir = await temporary(t);
  const recording = new RecordingDelegate({...camera, audio: true});
  t.after(() => recording.close());
  recording.updateRecordingConfiguration(configuration);
  recording.setAudioActive(true);
  recording.updateRecordingActive(true);
  await waitFor(() => recording.status === 'ready');
  recording.setMotion(true);
  const stream = recording.handleRecordingStreamRequest(12);
  const init = await stream.next(), fragment = await stream.next();
  const file = join(dir, 'source-audio.mp4');
  await writeFile(file, Buffer.concat([init.value.data, fragment.value.data]));
  const {stdout} = await run('ffmpeg', ['-v','error','-i',file,'-map','0:a:0','-f','s16le','pipe:1'], {encoding: 'buffer'});
  assert.ok(stdout.some((_, i) => i % 2 === 0 && Math.abs(stdout.readInt16LE(i)) > 1000), 'recording should contain the test tone');
  recording.setAudioActive(false);
  assert.equal((await stream.next()).done, true);
  await waitFor(() => recording.status === 'ready');
  const videoOnly = recording.handleRecordingStreamRequest(13);
  const videoInit = await videoOnly.next(), videoFragment = await videoOnly.next();
  await writeFile(file, Buffer.concat([videoInit.value.data, videoFragment.value.data]));
  const probe = await run('ffprobe', ['-v','error','-show_entries','stream=codec_type','-of','json',file]);
  assert.deepEqual(JSON.parse(probe.stdout).streams.map(s => s.codec_type), ['video']);
  await videoOnly.return();
});

mediaTest('live audio sends decryptable Opus with the HomeKit clock and respects microphone mute', async t => {
  const {SrtpSession, ProtectionProfileAes128CmHmacSha1_80} = await import('werift-rtp');
  const receiver = createSocket('udp4');
  receiver.bind(0, '127.0.0.1');
  await once(receiver, 'listening');
  t.after(() => receiver.close());
  const delegate = new StreamingDelegate({...camera, audio: true});
  t.after(() => delegate.close());
  const video = {port:receiver.address().port, srtpCryptoSuite:0, srtp_key:Buffer.alloc(16, 3), srtp_salt:Buffer.alloc(14, 4)};
  const audio = {...video, srtp_key:Buffer.alloc(16, 5), srtp_salt:Buffer.alloc(14, 6)};
  const prepared = await new Promise((resolve, reject) => delegate.prepareStream({
    sessionID:'av', sourceAddress:'127.0.0.1', targetAddress:'127.0.0.1', addressVersion:'ipv4', video, audio,
  }, (error, response) => error ? reject(error) : resolve(response)));
  assert.notEqual(prepared.audio.port, prepared.video.port);
  const decryptor = new SrtpSession({profile: ProtectionProfileAes128CmHmacSha1_80, keys: {
    localMasterKey: audio.srtp_key, localMasterSalt: audio.srtp_salt,
    remoteMasterKey: audio.srtp_key, remoteMasterSalt: audio.srtp_salt,
  }});
  const packets = [];
  let videoPackets = 0;
  receiver.on('message', (packet, source) => {
    if ((packet[1] & 127) === 99) videoPackets++;
    if ((packet[1] & 127) === 110) packets.push({data: packet, port: source.port});
  });
  await new Promise((resolve, reject) => delegate.handleStreamRequest({type:'start', sessionID:'av',
    video:{width:320,height:240,fps:15,max_bit_rate:200,profile:0,level:0,pt:99,mtu:1200,rtcp_interval:0.5},
    audio:{codec:'OPUS',channel:1,sample_rate:16,packet_time:20,pt:110,bit_rate:0,max_bit_rate:24},
  }, error => error ? reject(error) : resolve()));
  await waitFor(() => packets.length >= 5 && videoPackets > 0);
  const [first, second] = packets.map(({data}) => decryptor.decrypt(data));
  assert.ok(first.length > 12);
  assert.equal(first.readUInt32BE(8), prepared.audio.ssrc);
  assert.equal(packets[0].port, prepared.audio.port);
  assert.equal((second.readUInt32BE(4) - first.readUInt32BE(4)) >>> 0, 320);
  delegate.setMicrophone(true, 100);
  await delay(100);
  const mutedCount = packets.length, videoCount = videoPackets;
  await waitFor(() => videoPackets > videoCount + 5);
  assert.equal(packets.length, mutedCount);
  delegate.setMicrophone(false, 100);
  await waitFor(() => packets.length > mutedCount);
});

mediaTest('live SRTP is decrypted and decoded by a separate FFmpeg receiver', async t => {
  const dir = await temporary(t);
  const socket = createSocket('udp4'); socket.bind(0, '127.0.0.1'); await once(socket, 'listening');
  const port = socket.address().port; socket.close();
  const source = {port, srtpCryptoSuite:0, srtp_key:Buffer.alloc(16, 3), srtp_salt:Buffer.alloc(14, 4)};
  const key = Buffer.concat([source.srtp_key, source.srtp_salt]).toString('base64');
  const sdp = join(dir, 'live.sdp');
  await writeFile(sdp, `v=0\no=- 0 0 IN IP4 127.0.0.1\ns=HKSV Test\nc=IN IP4 127.0.0.1\nt=0 0\nm=video ${port} RTP/SAVP 99\na=rtpmap:99 H264/90000\na=fmtp:99 packetization-mode=1\na=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:${key}\n`);
  const receiver = spawn('ffmpeg', ['-v','error','-protocol_whitelist','file,udp,rtp,crypto','-i',sdp,'-frames:v','5','-f','null','-'], {stdio:'ignore'});
  t.after(() => receiver.kill('SIGKILL'));
  const received = once(receiver,'exit');
  const delegate = new StreamingDelegate(camera); t.after(() => delegate.close());
  await new Promise((resolve,reject) => delegate.prepareStream({sessionID:'decode',sourceAddress:'127.0.0.1',targetAddress:'127.0.0.1',addressVersion:'ipv4',video:source,audio:source}, e => e ? reject(e) : resolve()));
  await delay(300);
  await new Promise((resolve,reject) => delegate.handleStreamRequest({type:'start',sessionID:'decode',video:{width:320,height:240,fps:15,max_bit_rate:200,profile:0,level:0,pt:99,mtu:1200,rtcp_interval:0.5},audio:{}}, e => e ? reject(e) : resolve()));
  const timeout = setTimeout(() => receiver.kill('SIGKILL'), 10000);
  const [code] = await received; clearTimeout(timeout); assert.equal(code, 0, 'SRTP receiver could not decode video');
});
test('event buffer rejects slow consumers and cancellation releases waiting reads', async () => {
  const {RecordingEvent} = await import('../dist/recording.js');
  const event = new RecordingEvent(Buffer.from('init'), [Buffer.from('123')], 4);
  const stream = event.packets(); await stream.next();
  event.push(Buffer.from('56'));
  await assert.rejects(stream.next(), /too slow/);
  const waitingEvent = new RecordingEvent(Buffer.from('init'), []);
  const waitingStream = waitingEvent.packets(); await waitingStream.next();
  const pending = waitingStream.next(); waitingEvent.cancel(); assert.equal((await pending).done, true);
});
test('missing FFmpeg becomes a recoverable media error rather than crashing the engine', async t => {
  const original = process.env.HKSV_FFMPEG_PATH;
  process.env.HKSV_FFMPEG_PATH = '/nonexistent/hksv-ffmpeg';
  t.after(() => { if (original === undefined) delete process.env.HKSV_FFMPEG_PATH; else process.env.HKSV_FFMPEG_PATH = original; });
  const recording = new RecordingDelegate(camera); t.after(() => recording.close());
  recording.updateRecordingConfiguration(configuration); recording.updateRecordingActive(true);
  await waitFor(() => recording.status === 'media_error', 2000);
  recording.close(); assert.equal(recording.status, 'stopped');
});
