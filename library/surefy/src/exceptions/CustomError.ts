import { HttpStatusCode } from '../utils/HttpStatusCode';

export class CustomError extends Error {
  public statusCode: HttpStatusCode;
  public isOperational: boolean;
  public details?: any;

  constructor(message: string, statusCode: HttpStatusCode, isOperational = true, details?: any) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    this.details = details;

    Object.setPrototypeOf(this, CustomError.prototype);
    Error.captureStackTrace(this, this.constructor);
  }
}
