import { Request, Response, NextFunction } from 'express';
import { HttpStatusCode } from './HttpStatusCode';
import { sendResponse } from './Response';

export const tryCatchAsync = (fn: Function) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      await fn(req, res, next);
    } catch (error) {
      next(error);
    }
  };
};

export const successResponse = <T>(req: Request, res: Response, message: string, data?: T, statusCode = HttpStatusCode.OK) => {
  return sendResponse(res, statusCode, true, message, data);
};

export const errorResponse = (req: Request, res: Response, message: string, error?: any, statusCode = HttpStatusCode.INTERNAL_SERVER_ERROR) => {
  return sendResponse(res, statusCode, false, message, undefined, error);
};
