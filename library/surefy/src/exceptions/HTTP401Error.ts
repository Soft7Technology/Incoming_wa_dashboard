import { CustomError } from './CustomError';
import { HttpStatusCode } from '../utils/HttpStatusCode';

export default class HTTP401Error extends CustomError {
  constructor({ message = 'Unauthorized', details }: { message?: string; details?: any } = {}) {
    super(message, HttpStatusCode.UNAUTHORIZED, true, details);
  }
}
