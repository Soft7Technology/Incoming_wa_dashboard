import { createHmac, timingSafeEqual } from 'crypto';
import { Request, Response, NextFunction } from 'express';
import HTTP403Error from '@surefy/exceptions/HTTP403Error';

export function verifyMetaWebhookSignature(req: Request, _res: Response, next: NextFunction) {
  const secret = process.env.META_APP_SECRET;

  console.log('Req body',req.body)
  const signature = req.headers['x-hub-signature-256'];
  const raw = (req as Request & { rawBody?: Buffer }).rawBody;
  if (!secret || typeof signature !== 'string' || !/^sha256=[a-f0-9]{64}$/i.test(signature) || !raw) {
    return next(new HTTP403Error({ message: 'Valid Meta webhook signature is required' }));
  }
  const expected = createHmac('sha256', secret).update(raw).digest();
  const supplied = Buffer.from(signature.slice(7), 'hex');
  if (!timingSafeEqual(expected, supplied)) return next(new HTTP403Error({ message: 'Invalid Meta webhook signature' }));
  next();
}
