#!/usr/bin/env node
import {writeFile} from 'node:fs/promises';
const [command, id = 'test-camera', value] = process.argv.slice(2);
const token = process.env.HKSV_API_TOKEN;
const base = process.env.HKSV_ENGINE_URL ?? 'http://127.0.0.1:8099';
async function request(method, path, body) {
  const response = await fetch(base + path, {method, redirect:'error', headers:{Authorization:`Bearer ${token}`, 'Content-Type':'application/json'}, body:body && JSON.stringify(body), signal:AbortSignal.timeout(15000)});
  if (!response.ok) throw new Error(`Engine returned HTTP ${response.status}`);
  return response.json();
}
try {
  if (!token) throw new Error('Set HKSV_API_TOKEN to the engine token');
  if (!/^[a-z0-9_-]{1,64}$/.test(id)) throw new Error('Invalid camera ID');
  if (command === 'test-camera') {
    await request('POST', '/v1/cameras', {id, name:'Test Camera', rtspUrl:'test://pattern'});
    console.log(`Created ${id}. Run: npm run control -- pairing ${id}`);
  } else if (command === 'pairing') {
    const pairing = await request('GET', `/v1/cameras/${id}/pairing`);
    const path = `${id}-pairing.svg`;
    await writeFile(path, pairing.qrSvg, {mode:0o600});
    console.log(`HomeKit code: ${pairing.pincode}\nQR code saved to ${path}`);
  } else if (command === 'motion' && ['on','off'].includes(value)) {
    await request('POST', `/v1/cameras/${id}/motion`, {active:value === 'on'});
    console.log(`Motion ${value}`);
  } else if (command === 'status') {
    console.log(JSON.stringify(await request('GET','/v1/status'), null, 2));
  } else throw new Error('Usage: control test-camera [id] | pairing [id] | motion <id> on|off | status');
} catch (error) { console.error(error.message); process.exitCode = 1; }
