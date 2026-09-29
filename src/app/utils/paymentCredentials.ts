import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import HTTP500Error from '@surefy/exceptions/HTTP500Error';

function encryptionKey(): Buffer {
  const key = process.env.PAYMENT_GATEWAY_ENCRYPTION_KEY || '';
  if (!/^[a-fA-F0-9]{64}$/.test(key)) {
    throw new HTTP500Error({ message: 'PAYMENT_GATEWAY_ENCRYPTION_KEY must be configured as 64 hex characters' });
  }
  return Buffer.from(key, 'hex');
}

// Bind ciphertext to its company and configuration version to prevent row swapping.
export function encryptPaymentCredentials(credentials: object, context: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  cipher.setAAD(Buffer.from(context));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(credentials), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map(value => value.toString('base64')).join('.');
}

export function decryptPaymentCredentials(value: string, context: string): { key_id: string; key_secret: string } {
  const key = encryptionKey();
  try {
    const parts = value.split('.');
    if (parts.length !== 3 || parts.some(part => !part || Buffer.from(part, 'base64').toString('base64') !== part)) {
      throw new Error('Invalid ciphertext encoding');
    }
    const [iv, tag, ciphertext] = parts.map(part => Buffer.from(part, 'base64'));
    if (iv.length !== 12 || tag.length !== 16) throw new Error('Invalid ciphertext envelope');
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'));
  } catch {
    throw new HTTP500Error({ message: 'Unable to decrypt payment gateway credentials' });
  }
}
