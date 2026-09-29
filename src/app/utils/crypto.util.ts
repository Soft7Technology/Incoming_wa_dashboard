import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const SALT = 'surefy-ai-assistant-salt';

// We derive a 32-byte key using a provided ENCRYPTION_KEY or a fallback.
const getKey = () => {
  const secret = process.env.ENCRYPTION_KEY || 'default-surefy-secret-key-1234';
  return crypto.scryptSync(secret, SALT, 32);
};

export const encryptApiKey = (text: string | null | undefined): string | null => {
  if (!text) return null;
  // If it's already encrypted, don't double encrypt
  if (text.startsWith('enc:')) return text;

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  const authTag = cipher.getAuthTag().toString('hex');
  
  return `enc:${iv.toString('hex')}:${authTag}:${encrypted}`;
};

export const decryptApiKey = (encryptedText: string | null | undefined): string | null => {
  if (!encryptedText) return null;
  // If it's not encrypted (e.g. old plain text keys in DB), return as is
  if (!encryptedText.startsWith('enc:')) return encryptedText;

  try {
    const parts = encryptedText.split(':');
    if (parts.length !== 4) return encryptedText; // invalid format, return raw
    
    const iv = Buffer.from(parts[1], 'hex');
    const authTag = Buffer.from(parts[2], 'hex');
    const encrypted = parts[3];

    const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  } catch (error) {
    console.error('Error decrypting API Key:', error);
    return null;
  }
};

export const maskApiKey = (key: string | null | undefined): string | null => {
  if (!key) return null;
  if (key.length <= 8) return '********';
  
  const start = key.substring(0, 4);
  const end = key.substring(key.length - 4);
  return `${start}${'*'.repeat(12)}${end}`; // standard length masking
};
