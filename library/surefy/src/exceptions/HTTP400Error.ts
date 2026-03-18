import { CustomError } from './CustomError';
import { HttpStatusCode } from '../utils/HttpStatusCode';

export default class HTTP400Error extends CustomError {
  constructor({ message = 'Bad Request', details }: { message?: string; details?: any } = {}) {
    super(message, HttpStatusCode.BAD_REQUEST, true, details);
  }
}
