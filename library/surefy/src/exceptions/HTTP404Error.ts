import { CustomError } from './CustomError';
import { HttpStatusCode } from '../utils/HttpStatusCode';

export default class HTTP404Error extends CustomError {
  constructor({ message = 'Resource Not Found', details }: { message?: string; details?: any } = {}) {
    super(message, HttpStatusCode.NOT_FOUND, true, details);
  }
}
