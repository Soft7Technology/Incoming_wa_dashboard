import type { RequestHandler } from 'express';

/** Reject overload before parsing bodies or acquiring database connections. */
export function requestCapacity(max = Number(process.env.API_MAX_IN_FLIGHT || 64)): RequestHandler {
  if (!Number.isSafeInteger(max) || max < 1) throw new Error('API_MAX_IN_FLIGHT must be a positive integer');
  let active = 0;
  let imports = 0;
  return (req, res, next) => {
    if (req.path === '/live' || req.path === '/health' ||
      /^\/v1\/(?:admin|super-admin)\/support\/live\/events\/?$/.test(req.path)) return next();
    const importing = /^\/v1\/(?:admin|api)\/contacts\/import(?:\/preview)?\/?$/.test(req.path);
    if (active >= max || importing && imports >= 1) {
      res.setHeader('Retry-After', '1');
      res.status(503).json({ success: false, message: 'The service is busy. Please try again shortly.' });
      return;
    }
    active++;
    if (importing) imports++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true; active--;
      if (importing) imports--;
      res.off('finish', release); res.off('close', release);
    };
    res.once('finish', release); res.once('close', release);
    next();
  };
}
