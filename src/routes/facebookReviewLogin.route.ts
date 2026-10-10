import { Router } from 'express';
import crypto from 'crypto';
import authController from '../app/http/controllers/auth.controller';

const route = Router();

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
