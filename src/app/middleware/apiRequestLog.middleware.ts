import { Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { AuthRequest } from '@surefy/middleware/auth.middleware';
import ApiRequestLogModel from '../models/apiRequestLog.model';
import { apiLogBody } from '../utils/apiLogBody';

export async function recordApiRequest(req: AuthRequest, res: Response, next: NextFunction) {
  const started = Date.now();
  const id = uuidv4();
  try {
    if (!req.userId || !req.companyId || !req.apiKeyId) throw new Error('Missing API key context');
    // Commit before handlers run, so even a killed process leaves a pending record.
    await ApiRequestLogModel.create({
      id, user_id: req.userId, company_id: req.companyId, api_key_id: req.apiKeyId,
      key_prefix: req.apiKeyPrefix, method: req.method,
      endpoint: String(apiLogBody(req.originalUrl.split('?')[0])).slice(0, 2048),
      query: JSON.stringify(apiLogBody(req.query)), request_body: JSON.stringify(apiLogBody(req.body)),
    });
  } catch {
    // Do not execute an untracked send, and do not leak database error parameters.
    console.error('API request audit could not be created');
    res.status(503).json({ success: false, message: 'API request logging is temporarily unavailable. No action was started.' });
    return;
  }
  req.apiRequestId = id;
  res.setHeader('X-API-Request-ID', id);
  let responseBody: unknown = null;
  let applicationFailed = false;
  const originalJson = res.json;
  res.json = function (body: any) {
    applicationFailed = body?.success === false;
    responseBody = apiLogBody(body);
    return originalJson.call(this, body);
  };
  let completed = false;
  const finish = (aborted: boolean) => {
    if (completed) return;
    completed = true;
    const failed = res.statusCode >= 400 || applicationFailed;
    void ApiRequestLogModel.finish(id, {
      http_status: aborted ? null : res.statusCode,
      outcome: aborted ? 'aborted' : failed ? 'failed' : 'success',
      response_body: JSON.stringify(responseBody), completed_at: new Date(),
      duration_ms: Math.min(2147483647, Date.now() - started),
    }).catch(() => console.error('API request audit completion failed', { requestId: id }));
  };
  res.once('finish', () => finish(false));
  res.once('close', () => finish(!res.writableFinished));
  if (res.destroyed) { finish(true); return; }
  next();
}
