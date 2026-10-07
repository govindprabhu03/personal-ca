// Encrypted backup: AES-256-GCM, key derived from your passphrase with scrypt. Wrong passphrase => decrypt throws.
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

export function encrypt(plain: string, pass: string): string {
  const salt = randomBytes(16), iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', scryptSync(pass, salt, 32), iv);
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return JSON.stringify({
    v: 1, alg: 'aes-256-gcm+scrypt',
    salt: salt.toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64'),
  });
}

export function decrypt(blob: string, pass: string): string {
  const b = JSON.parse(blob);
  const d = createDecipheriv('aes-256-gcm', scryptSync(pass, Buffer.from(b.salt, 'base64'), 32), Buffer.from(b.iv, 'base64'));
  d.setAuthTag(Buffer.from(b.tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(b.data, 'base64')), d.final()]).toString('utf8');
}
