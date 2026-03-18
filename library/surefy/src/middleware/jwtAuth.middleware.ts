import { Request, Response, NextFunction } from 'express';
import HTTP401Error from '../exceptions/HTTP401Error';
import jwt from 'jsonwebtoken';

export interface JWTAuthRequest extends Request {
  userId?: string;
  userRole?: string;
  companyId?: string;
  email?: string;
  phone?: string;
}

interface JWTPayload {
  userId: string;
  email?: string;
  phone?: string;
  role: string;
  companyId?: string;
}

/**
 * JWT Authentication middleware
 * Requires Authorization: Bearer <token> header
 */
export const jwtAuthMiddleware = async (req: JWTAuthRequest, res: Response, next: NextFunction) => {
  try {
    const authHeader = req.headers['authorization'];

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new HTTP401Error({ message: 'No token provided. Authorization header required' });
    }

    const token = authHeader.substring(7); // Remove 'Bearer ' prefix

    if (!token) {
      throw new HTTP401Error({ message: 'Invalid token format' });
    }

    // Verify token
    const JWT_SECRET = process.env.JWT_SECRET || '1428736492837465';
    let decoded: JWTPayload;

    try {
      decoded = jwt.verify(token, JWT_SECRET) as JWTPayload;
    } catch (error) {
      throw new HTTP401Error({ message: 'Invalid or expired token' });
    }

    // Attach user info to request
    req.userId = decoded.userId;
    req.userRole = decoded.role;
    req.companyId = decoded.companyId;
    req.email = decoded.email;
    req.phone = decoded.phone;

    next();
  } catch (error) {
    next(error);
  }
};

/**
 * Role-based authorization middleware
 * Usage: requireRole('admin', 'superadmin')
 */
export const requireRole = (...allowedRoles: string[]) => {
  return (req: JWTAuthRequest, res: Response, next: NextFunction) => {
    try {
      if (!req.userRole) {
        throw new HTTP401Error({ message: 'No user role found in request' });
      }

      if (!allowedRoles.includes(req.userRole)) {
        throw new HTTP401Error({
          message: `Access denied. Required role: ${allowedRoles.join(' or ')}`,
        });
      }

      next();
    } catch (error) {
      next(error);
    }
  };
};

/**
 * Optional JWT authentication middleware
 * Validates if token is provided but doesn't fail if missing
 */
export const optionalJWTAuthMiddleware = async (
  req: JWTAuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const authHeader = req.headers['authorization'];

    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.substring(7);

      if (token) {
        const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

        try {
          const decoded = jwt.verify(token, JWT_SECRET) as JWTPayload;

          req.userId = decoded.userId;
          req.userRole = decoded.role;
          req.companyId = decoded.companyId;
          req.email = decoded.email;
          req.phone = decoded.phone;
        } catch (error) {
          // Token is invalid, but we don't fail - just continue without auth
        }
      }
    }

    next();
  } catch (error) {
    next(error);
  }
};
