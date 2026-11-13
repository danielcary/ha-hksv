import { randomBytes, randomInt } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
export interface Identity { username: string; pincode: string; setupID: string }
export async function loadIdentity(directory: string, id: string): Promise<Identity> {
  if (!/^[a-z0-9_-]{1,64}$/.test(id)) throw new Error('Invalid identity id');
  await mkdir(directory, {recursive: true, mode: 0o700});
  const file = join(directory, `${id}.json`);
  try {
    const value = JSON.parse(await readFile(file, 'utf8'));
    if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(value.username) || !/^\d{3}-\d{2}-\d{3}$/.test(value.pincode) || !/^[A-Z0-9]{4}$/.test(value.setupID)) throw new Error('Corrupt HomeKit identity');
    return value;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const bytes = randomBytes(6); bytes[0] = (bytes[0] | 2) & 254;
  let digits: string;
  do { digits = String(randomInt(100000000)).padStart(8, '0'); } while (/^(\d)\1{7}$/.test(digits) || ['12345678', '87654321'].includes(digits));
  const identity = {username: [...bytes].map(n => n.toString(16).padStart(2, '0')).join(':').toUpperCase(),
    pincode: `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`, setupID: randomBytes(2).toString('hex').toUpperCase()};
  await writeFile(file, JSON.stringify(identity), {mode: 0o600, flag: 'wx'});
  return identity;
}
