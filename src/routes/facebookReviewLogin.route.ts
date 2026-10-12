import { Router } from 'express';
import crypto from 'crypto';
import authController from '../app/http/controllers/auth.controller';
import jwt from 'jsonwebtoken';
import { facebookReviewPurpose, facebookReviewSecret } from '@surefy/utils/facebookReviewSession';

const route = Router();

route.post('/public', (req, res, next) => {
  if (process.env.FACEBOOK_REVIEW_PUBLIC_ENABLED !== 'true') {
    res.status(404).json({ success: false, message: 'Public review login is disabled.' });
    return;
  }
  const email = process.env.FACEBOOK_REVIEW_EMAIL;
  const password = process.env.FACEBOOK_REVIEW_PASSWORD;
  const pageId = process.env.FACEBOOK_REVIEW_PAGE_ID || '';
  const secret = process.env.JWT_SECRET;
  const expires = Date.parse(process.env.FACEBOOK_REVIEW_EXPIRES_AT || '');
  if (
    process.env.FACEBOOK_REVIEW_ENABLED !== 'true' || !email || !password || !secret ||
    !/^\d{1,80}$/.test(pageId) || !Number.isFinite(expires) || expires <= Date.now()
  ) {
    res.status(503).json({ success: false, message: 'Public review login is unavailable. Check the server review settings.' });
    return;
  }
  const send = res.json.bind(res);
  res.json = (body: any) => {
    if (!body?.success || !body.data?.token) return send(body);
    try {
      const claims = jwt.verify(body.data.token, secret) as jwt.JwtPayload;
      const token = jwt.sign({
        userId: claims.userId, ownerId: claims.ownerId || claims.userId,
        companyId: claims.companyId, role: claims.role,
        purpose: facebookReviewPurpose, reviewPageId: pageId,
      }, facebookReviewSecret(secret), {
        expiresIn: Math.min(3600, Math.floor((expires - Date.now()) / 1000)),
      });
      // Never return the normal account JWT, password, or other account data.
      return send({ success: true, data: { token, data: { name: body.data.data?.name || 'Review account' } } });
    } catch {
      res.status(503);
      return send({ success: false, message: 'Could not create the review session.' });
    }
  };
  req.body = { identifier: email, password, domain_name: process.env.FACEBOOK_REVIEW_DOMAIN || req.hostname };
  return authController.login(req, res, next);
});

// The review URL carries a random access key in its fragment, never a password.
// Only its SHA-256 hash is configured on the server. Ordinary login is unchanged.
route.post('/', (req, res, next) => {
  const expected = process.env.FACEBOOK_REVIEW_KEY_HASH || '';
  const email = process.env.FACEBOOK_REVIEW_EMAIL;
  const password = process.env.FACEBOOK_REVIEW_PASSWORD;
  const expires = Date.parse(process.env.FACEBOOK_REVIEW_EXPIRES_AT || '');
  if (
    process.env.FACEBOOK_REVIEW_ENABLED !== 'true' ||
    !/^[a-f0-9]{64}$/.test(expected) ||
    !email ||
    !password ||
    !Number.isFinite(expires)
  ) {
    res.status(404).json({ success: false, message: 'Review login is unavailable.' });
    return;
  }
  const key = req.body?.key;
  if (
    expires <= Date.now() ||
    typeof key !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(key) ||
    !crypto.timingSafeEqual(crypto.createHash('sha256').update(key).digest(), Buffer.from(expected, 'hex'))
  ) {
    res.status(403).json({ success: false, message: 'This review link is invalid or has expired.' });
    return;
  }
  // Reuse normal password validation, company-domain checks and login auditing.
  // Caller-supplied identifiers/passwords cannot select another account.
  req.body = { identifier: email, password, domain_name: process.env.FACEBOOK_REVIEW_DOMAIN || req.hostname };
  return authController.login(req, res, next);
});

export default route;
