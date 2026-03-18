import db from '../database';
import * as crypto from 'crypto';

/**
 * Generate secure company key from company ID
 * This creates a non-reversible but deterministic key
 */
export const generateCompanyKey = (companyId: string, salt: string): string => {
  return crypto
    .createHmac('sha256', salt || process.env.API_KEY_SALT || 'default-salt')
    .update(companyId)
    .digest('hex')
    .substring(0, 32); // 32 character key
};

/**
 * Validate company key and extract company ID
 */
export const validateCompanyKey = async (apiKey: string, companyKey: string): Promise<string | null> => {
  try {
    // Find company by API key directly using db
    const company = await db('companies')
      .where({ api_key: apiKey, status: 'active' })
      .whereNull('deleted_at')
      .first();

    if (!company) {
      return null;
    }

    // Generate expected company key
    const expectedKey = generateCompanyKey(company.id, process.env.API_KEY_SALT || '');

    // Compare keys (constant-time comparison to prevent timing attacks)
    if (!crypto.timingSafeEqual(Buffer.from(companyKey), Buffer.from(expectedKey))) {
      return null;
    }

    return company.id;
  } catch (error) {
    console.error('Error validating company key:', error);
    return null;
  }
};
