import { Request, Response, NextFunction } from 'express';
import { CustomError } from '../exceptions/CustomError';
import { HttpStatusCode } from '../utils/HttpStatusCode';
import { sendResponse } from '../utils/Response';

export const errorHandler = (err: Error, req: Request, res: Response, next: NextFunction) => {
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
