import { Request, Response, NextFunction } from 'express';
import { CustomError } from '../exceptions/CustomError';
import { HttpStatusCode } from '../utils/HttpStatusCode';
import { sendResponse } from '../utils/Response';
import { getDatabaseFailure, reportBackgroundError } from '../utils/databaseErrors';

export const errorHandler = (err: Error, req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) return next(err);
  if (getDatabaseFailure(err)) {
    reportBackgroundError('API database', err);
    res.setHeader('Retry-After', '30');
    return sendResponse(res, HttpStatusCode.SERVICE_UNAVAILABLE, false,
      'A required service is temporarily unavailable. Please try again later.');
  }
  if (err instanceof CustomError) {
    return sendResponse(res, err.statusCode, false, err.message, undefined, err.details);
  }

  // Log unexpected errors
  console.error('Unexpected error:', err);

  return sendResponse(
    res,
    HttpStatusCode.INTERNAL_SERVER_ERROR,
    false,
    'An unexpected error occurred',
    undefined,
    process.env.NODE_ENV === 'development' ? err.message : undefined,
  );
};
