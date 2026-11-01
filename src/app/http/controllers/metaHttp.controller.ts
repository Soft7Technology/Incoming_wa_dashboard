import { NextFunction, Request, RequestHandler, Response } from 'express';
import { JWTAuthRequest } from '@surefy/middleware/jwtAuth.middleware';
import { FacebookError } from '../../utils/facebook';

export const metaHandler =
  (fn: (req: JWTAuthRequest, res: Response) => Promise<unknown>): RequestHandler =>
  async (req, res, next) => {
    try {
      await fn(req as JWTAuthRequest, res);
    } catch (error) {
      next(error);
    }
  };

export const noStore: RequestHandler = (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');
  next();
};

export function metaError(error: unknown, _req: Request, res: Response, _next: NextFunction) {
  const safe = error instanceof FacebookError ? error : new FacebookError(500, 'Integration operation failed. Please try again.');
  if (!(error instanceof FacebookError)) console.error('[Integration] Operation failed; details suppressed.');
  res.status(safe.status).json({ success: false, message: safe.message, code: safe.code });
}
