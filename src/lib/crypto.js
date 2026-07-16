import crypto from 'node:crypto';
import { config } from '../config.js';

const key = () => {
  if (!config.APP_ENCRYPTION_KEY) return crypto.createHash('sha256').update('followpilot-development-only').digest();
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
