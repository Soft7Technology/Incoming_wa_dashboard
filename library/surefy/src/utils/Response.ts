import { Response } from 'express';
import { HttpStatusCode } from './HttpStatusCode';

export interface ApiResponse<T = any> {
  success: boolean;
  message: string;
  data?: T;
  error?: any;
  meta?: {
    timestamp: string;
    path?: string;
  };
}

export const sendResponse = <T>(
  res: Response,
  statusCode: HttpStatusCode,
  success: boolean,
  message: string,
  data?: T,
  error?: any,
): Response => {
  const response: ApiResponse<T> = {
    success,
    message,
    ...(data && { data }),
    ...(error && { error }),
    meta: {
      timestamp: new Date().toISOString(),
    },
  };

  return res.status(statusCode).json(response);
};
