import crypto from 'crypto';

export const facebookReviewPurpose = 'facebook-public-review';

// Public demo sessions must not validate as normal application/reset tokens.
export const facebookReviewSecret = (secret: string) =>
  crypto.createHmac('sha256', secret).update('facebook-public-review-session-v1').digest('hex');
