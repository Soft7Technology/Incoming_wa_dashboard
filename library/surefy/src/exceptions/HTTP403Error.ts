import { CustomError } from './CustomError';
import { HttpStatusCode } from '../utils/HttpStatusCode';

export default class HTTP403Error extends CustomError {
  constructor({ message = 'Forbidden', details }: { message?: string; details?: any } = {}) {
    super(message, HttpStatusCode.FORBIDDEN, true, details);
  }
}
