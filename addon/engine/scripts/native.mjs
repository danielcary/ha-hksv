#!/usr/bin/env node
/** Dedicated local trial; credentials and pairings stay under data/mac-test. */
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

const directory = fileURLToPath(new URL('../../../data/mac-test/', import.meta.url));
const [command, argument, ...flags] = process.argv.slice(2);
const allowed = ['start', 'add-camera', 'status', 'pairing', 'motion'];
try {
  if (!allowed.includes(command) || (command !== 'add-camera' && argument !== undefined)
    || flags.some(flag => !['--audio', '--software-motion'].includes(flag))) {
    throw new Error('Usage: npm run native -- start | add-camera <rtsp-url> [--audio] [--software-motion] | status | pairing | motion');
  }
  if (command === 'add-camera' && !argument) throw new Error('Supply an RTSP URL or test://pattern');
  const file = join(directory, 'options.json');
  let options;
  try { options = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Unable to read native test configuration');
    if (command !== 'start') throw new Error('Start the native engine first');
    await mkdir(directory, {recursive:true, mode:0o700});
    options = {api_token:randomBytes(32).toString('hex')};
    await writeFile(file, JSON.stringify(options), {mode:0o600, flag:'wx'});
  }
  if (typeof options.api_token !== 'string' || options.api_token.length < 32) throw new Error('Invalid native test token');
  if (command === 'start') {
    process.env.HKSV_DATA_DIR = directory;
    process.env.HKSV_API_TOKEN = options.api_token;
    process.env.HKSV_BIND_ADDRESS = '127.0.0.1';
    console.log('Starting the native trial. Keep this terminal open; Ctrl+C stops it.');
    await import('../dist/index.js');
  } else {
    async function request(method, path, body) {
      const response = await fetch('http://127.0.0.1:8099' + path, {
        method, redirect:'error', headers:{Authorization:`Bearer ${options.api_token}`, 'Content-Type':'application/json'},
        body:body && JSON.stringify(body), signal:AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error(`Engine returned HTTP ${response.status}`);
      return response.json();
    }
    if (command === 'add-camera') {
      const {parseCamera} = await import('../dist/config.js');
      const camera = parseCamera({id:'pi-camera', name:'RTSP Test Camera', rtspUrl:argument,
        audio:flags.includes('--audio'), softwareMotion:flags.includes('--software-motion')});
      await request('POST', '/v1/cameras', camera);
      console.log('Camera added. Run npm run native -- pairing to get its pairing code.');
    } else if (command === 'status') {
      console.log(JSON.stringify(await request('GET', '/v1/status'), null, 2));
    } else if (command === 'pairing') {
      const pairing = await request('GET', '/v1/cameras/pi-camera/pairing');
      const path = join(directory, 'pi-camera-pairing.svg');
      await writeFile(path, pairing.qrSvg, {mode:0o600});
      console.log(`Pairing code: ${pairing.pincode}\nQR code: ${path}`);
    } else if (command === 'motion') {
      const clear = () => request('POST', '/v1/cameras/pi-camera/motion', {active:false});
      const interrupted = () => { void clear().then(() => process.exit(130), () => process.exit(1)); };
      process.once('SIGINT', interrupted); process.once('SIGTERM', interrupted);
      try {
        await request('POST', '/v1/cameras/pi-camera/motion', {active:true});
        console.log('Motion on for eight seconds.');
        await delay(8000);
      } finally {
        await clear();
        process.removeListener('SIGINT', interrupted); process.removeListener('SIGTERM', interrupted);
      }
      console.log('Motion off.');
    }
  }
} catch (error) {
  // Fetch errors can embed credential-bearing URLs in their cause; omit the cause.
  console.error(error.message); process.exitCode = 1;
}
