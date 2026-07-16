import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

let generatedKey;
const key = () => {
  if (!config.APP_ENCRYPTION_KEY) {
    if (generatedKey) return generatedKey;
    if (config.DATABASE_PATH === ':memory:') return (generatedKey = crypto.randomBytes(32));
    const keyPath = path.join(path.dirname(path.resolve(config.DATABASE_PATH)), '.followpilot-master-key');
    fs.mkdirSync(path.dirname(keyPath), { recursive: true });
    if (fs.existsSync(keyPath)) generatedKey = Buffer.from(fs.readFileSync(keyPath, 'utf8').trim(), 'hex');
    else {
      generatedKey = crypto.randomBytes(32);
      fs.writeFileSync(keyPath, generatedKey.toString('hex'), { mode: 0o600 });
    }
    return generatedKey;
  }
  if (/^[a-f0-9]{64}$/i.test(config.APP_ENCRYPTION_KEY)) return Buffer.from(config.APP_ENCRYPTION_KEY, 'hex');
  return crypto.createHash('sha256').update(config.APP_ENCRYPTION_KEY).digest();
};

export function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map((part) => part.toString('base64url')).join('.');
}

export function decrypt(value) {
  const [iv, tag, encrypted] = value.split('.').map((part) => Buffer.from(part, 'base64url'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

export const randomToken = () => crypto.randomBytes(24).toString('base64url');
export const safeEqual = (a, b) => {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
};
