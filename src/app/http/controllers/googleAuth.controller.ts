import { Request, Response, NextFunction } from 'express';
import { JWTAuthRequest } from '@surefy/middleware/jwtAuth.middleware';
import { successResponse, tryCatchAsync } from '@surefy/utils/Controller';
import { CustomError } from '@surefy/exceptions/CustomError';
import googleAuthService, { googleAuthConfig } from '../../services/googleAuth.service';
import authService from '../../services/auth.service';
import db from '@surefy/database';

const proxyAddress = require('proxy-addr');
export function googleAuthClientIp(req: Request): string {
  // Trust forwarded addresses only when the immediate peer matches operator-configured proxies.
  const proxies = (process.env.GOOGLE_AUTH_TRUSTED_PROXIES || '').split(',').map(value => value.trim()).filter(Boolean);
  return proxyAddress(req, proxies.length ? proxyAddress.compile(proxies) : () => false);
}

// GIS JavaScript callback only. Reject form posts and untrusted/missing origins.
// These endpoints return JWTs in JSON and do not use ambient login cookies.
export const googleAuthRequest = (req: Request, res: Response, next: NextFunction) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  try {
    googleAuthConfig(req.get('origin'));
    if (req.method === 'POST' && !req.is('application/json')) {
      throw new CustomError('Use application/json for Google sign-in.', 400);
    }
    next();
  } catch (error) { next(error); }
};

class GoogleAuthController {
  start = tryCatchAsync(async (req: Request, res: Response) => {
    const data = await googleAuthService.start(req.get('origin'), googleAuthClientIp(req));
    return successResponse(req, res, 'Google sign-in started', data);
  });

  login = tryCatchAsync(async (req: Request, res: Response) => {
    const result = await googleAuthService.complete(req.get('origin'), req.body);
    const session = await authService.createSession(result.user, googleAuthClientIp(req), result.domain);
    return successResponse(req, res, 'Google sign-in successful', { ...session, is_new_user: result.created });
  });

  linkStart = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => {
    const data = await googleAuthService.start(req.get('origin'), googleAuthClientIp(req), req.userId!);
    return successResponse(req, res, 'Connect Google started', data);
  });

  link = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => {
    await googleAuthService.complete(req.get('origin'), req.body, req.userId!);
    return successResponse(req, res, 'Google account connected', { google_connected: true });
  });

  status = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => {
    const user = await db('users').where({ id: req.userId }).whereNull('deleted_at').first('password');
    const identity = await db('google_auth_identities').where({ user_id: req.userId }).first('user_id');
    return successResponse(req, res, 'Sign-in methods', {
      google_connected: !!identity, has_password: !!user?.password,
    });
  });
}

export default new GoogleAuthController();
