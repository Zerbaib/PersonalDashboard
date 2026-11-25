import crypto from 'node:crypto';
import { config } from './config.js';

// Clé AES-256 dérivée de MASTER_KEY : les mots de passe SSH sont chiffrés au repos.
const key = crypto.scryptSync(config.masterKey, 'personaldashboard:v1', 32);

export function encrypt(plain) {
  if (plain == null || plain === '') return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}

export function decrypt(blob) {
  if (!blob) return null;
  const [version, iv, tag, data] = blob.split(':');
  if (version !== 'v1') throw new Error('Format de chiffrement inconnu');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}
