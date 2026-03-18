import { CustomError } from './CustomError';
import { HttpStatusCode } from '../utils/HttpStatusCode';

export default class HTTP500Error extends CustomError {
  constructor({ message = 'Internal Server Error', details }: { message?: string; details?: any } = {}) {
    super(message, HttpStatusCode.INTERNAL_SERVER_ERROR, false, details);
  }
}
