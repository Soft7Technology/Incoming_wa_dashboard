import { createHash, randomBytes, createCipheriv, createDecipheriv } from 'crypto';
import { validate as isUUID } from 'uuid';
import UserApiKeyModel from '../models/userApiKey.model';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';
import HTTP403Error from '@surefy/exceptions/HTTP403Error';
import HTTP404Error from '@surefy/exceptions/HTTP404Error';

export interface ApiKeyAccount {
  userId?: string;
  companyId?: string;
  ownerId?: string;
  userRole?: string;
}

export const hashApiKey = (key: string) => createHash('sha256').update(key).digest('hex');

function encryptionKey(): Buffer {
  const secret = process.env.USER_API_KEY_ENCRYPTION_KEY;
  if (!secret || !/^[a-fA-F0-9]{64}$/.test(secret)) {
    throw new Error('USER_API_KEY_ENCRYPTION_KEY must be a 64-character hexadecimal secret');
  }
  return Buffer.from(secret, 'hex');
}

function encryptKey(value: string, userId: string, companyId: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  cipher.setAAD(Buffer.from(`${userId}:${companyId}`));
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map(part => part.toString('hex')).join(':');
}

function decryptKey(value: string, userId: string, companyId: string): string {
  const [iv, tag, encrypted] = value.split(':');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(iv, 'hex'));
  decipher.setAAD(Buffer.from(`${userId}:${companyId}`));
  decipher.setAuthTag(Buffer.from(tag, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, 'hex')), decipher.final()]).toString('utf8');
}

class UserApiKeyService {
  async validateUser(account: ApiKeyAccount) {
    const { userId, companyId } = account;
    if (!userId || !companyId) {
      throw new HTTP403Error({ message: 'User and company context are required' });
    }
    if (!await UserApiKeyModel.findActiveUser(userId, companyId)) {
      throw new HTTP403Error({ message: 'Active user required' });
    }
    return { userId, companyId };
  }

  async createKey(account: ApiKeyAccount) {
    const { userId, companyId } = await this.validateUser(account);
    const apiKey = `s7_${randomBytes(32).toString('hex')}`;
    const record = await UserApiKeyModel.createKey({
      user_id: userId,
      company_id: companyId,
      key_hash: hashApiKey(apiKey),
      api_key_encrypted: encryptKey(apiKey, userId, companyId),
      key_prefix: apiKey.slice(0, 12)
    });
    return { ...record, apiKey };
  }

  async getKeys(account: ApiKeyAccount) {
    const { userId, companyId } = await this.validateUser(account);
    const keys = await UserApiKeyModel.findByOwner(userId, companyId);
    return keys.map(({ api_key_encrypted, ...metadata }) => ({
      ...metadata,
      apiKey: api_key_encrypted ? decryptKey(api_key_encrypted, userId, companyId) : null,
    }));
  }

  async revokeKey(account: ApiKeyAccount, id: string) {
    const { userId, companyId } = await this.validateUser(account);
    if (!isUUID(id)) throw new HTTP400Error({ message: 'Invalid API key ID' });
    if (!await UserApiKeyModel.revokeByOwner(id, userId, companyId)) {
      throw new HTTP404Error({ message: 'API key not found' });
    }
  }

  async authenticate(key: string) {
    if (!/^s7_[a-f0-9]{64}$/.test(key)) return null;
    return UserApiKeyModel.findActiveByHash(hashApiKey(key));
  }
}

export default new UserApiKeyService();
