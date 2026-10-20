import HTTP400Error from '@surefy/exceptions/HTTP400Error';

/** Applied when setting a password; existing passwords are not silently changed. */
export function assertStrongPassword(password: unknown): asserts password is string {
  if (typeof password !== 'string' || Array.from(password).length < 12 || Buffer.byteLength(password, 'utf8') > 72)
    throw new HTTP400Error({ message: 'Use a password of at least 12 characters and at most 72 UTF-8 bytes.' });
}
