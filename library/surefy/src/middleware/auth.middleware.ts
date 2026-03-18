import { Request, Response, NextFunction } from 'express';
import HTTP401Error from '../exceptions/HTTP401Error';
import { generateCompanyKey, validateCompanyKey } from '../services/auth.service';

export interface AuthRequest extends Request {
  companyId?: string;
  userId?: string;
  apiKey?: string;
}

// Re-export for use in other files
export { generateCompanyKey };

/**
 * Authentication middleware
 * Requires both x-api-key and x-company-key headers
 */
export const authMiddleware = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const apiKey = req.headers['x-api-key'] as string;
    const companyKey = req.headers['x-company-key'] as string;

    if (!apiKey || !companyKey) {
      throw new HTTP401Error({ message: 'API key and Company key are required' });
    }

    // Validate and get company ID
    const companyId = await validateCompanyKey(apiKey, companyKey);

    if (!companyId) {
      throw new HTTP401Error({ message: 'Invalid API key or Company key' });
    }

    // Attach to request
    req.apiKey = apiKey;
    req.companyId = companyId;

    next();
  } catch (error) {
    next(error);
  }
};

/**
 * Optional authentication middleware
 * Validates if credentials are provided but doesn't fail if missing
 */
export const optionalAuthMiddleware = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const apiKey = req.headers['x-api-key'] as string;
    const companyKey = req.headers['x-company-key'] as string;

    if (apiKey && companyKey) {
      const companyId = await validateCompanyKey(apiKey, companyKey);

      if (companyId) {
        req.apiKey = apiKey;
        req.companyId = companyId;
      }
    }

    next();
  } catch (error) {
    next(error);
  }
};
