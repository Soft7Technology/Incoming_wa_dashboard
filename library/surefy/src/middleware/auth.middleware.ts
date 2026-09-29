import { authenticateUserApiKey } from '../services/userApiKey.service';
import { Request, Response, NextFunction } from 'express';
import HTTP401Error from '../exceptions/HTTP401Error';
import { generateCompanyKey } from '../services/auth.service';

export interface AuthRequest extends Request {
  companyId?: string;
  userId?: string;
  userRole?: string;
  apiKey?: string;
  assigned_plan?:string
  /** For team members: the inviter's userId whose data they should see */
  ownerId?: string;
}

// Re-export for use in other files
export { generateCompanyKey };

/** Authenticate a user API key and derive its user/company context. */
export const authMiddleware = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const legacyKey = req.headers['x-api-key'];
    const authorization = req.headers.authorization;
    let bearerKey: string | undefined;

    if (authorization !== undefined) {
      const match = typeof authorization === 'string' ? /^Bearer\s+(\S+)$/i.exec(authorization.trim()) : null;
      if (!match) throw new HTTP401Error({ message: 'Provide Authorization: Bearer <user-api-key>' });
      bearerKey = match[1];
    }
    if (legacyKey !== undefined && (typeof legacyKey !== 'string' || !legacyKey.trim())) {
      throw new HTTP401Error({ message: 'Provide a valid x-api-key header' });
    }
    // Keep existing integrations compatible, but reject conflicting identities.
    const headerKey = typeof legacyKey === 'string' ? legacyKey.trim() : undefined;
    if (bearerKey && headerKey && bearerKey !== headerKey) {
      throw new HTTP401Error({ message: 'Authorization and x-api-key must contain the same user API key' });
    }
    const apiKey = bearerKey || headerKey;
    if (!apiKey) throw new HTTP401Error({ message: 'Provide Authorization: Bearer <user-api-key> or x-api-key' });

    const account = await authenticateUserApiKey(apiKey);
    if (!account) throw new HTTP401Error({ message: 'Invalid or revoked API key' });

    req.userId = account.userId;
    req.ownerId = account.userId;
    req.companyId = account.companyId;
    req.userRole = account.userRole;
    return next();
  } catch (error) {
    next(error);
  }
};

/** Allow anonymous requests only when no API key was supplied. */
export const optionalAuthMiddleware = async (req: AuthRequest, res: Response, next: NextFunction) => {
  if (req.headers['x-api-key'] === undefined && req.headers.authorization === undefined) return next();
  return authMiddleware(req, res, next);
};
