import HTTP403Error from '@surefy/exceptions/HTTP403Error';
import { normalizeFeatures } from './planFeatures';
import { resolveTrialDays } from './subscriptionDuration';

export const DEFAULT_TRIAL_DAYS = 10;
export const ALLOWED_TRIAL_DAYS = [3, 7, 10] as const;

/** Fresh objects prevent a caller changing the shared platform trial policy. */
export function freeTrialFeatures() {
  return normalizeFeatures({
    TeamInvite: { limit_value: 2 },
    Contact: { limit_value: 500 },
    Campaign: { limit_value: 2 },
    WabaNumber: { limit_value: 1 },
    Chatbot: { limit_value: 2 },
    AiAssistant: { limit_value: 1 },
  });
}

export function newTrialDays(value?: unknown): 3 | 7 | 10 {
  return resolveTrialDays('Free', value === undefined ? DEFAULT_TRIAL_DAYS : value) as 3 | 7 | 10;
}

/** Accept an identical feature map for forms, but never accept changed limits or additional features. */
export function fixedTrialFeatures(input?: unknown) {
  const expected = freeTrialFeatures();
  if (input === undefined) return expected;
  const actual = normalizeFeatures(input);
  if (
    Object.keys(actual).length !== Object.keys(expected).length ||
    Object.keys(expected).some(
      (key) =>
        !actual[key] ||
        actual[key].limit_value !== expected[key].limit_value ||
        actual[key].enabled !== true ||
        actual[key].reset_period !== 'never',
    )
  ) {
    throw new HTTP403Error({
      message:
        'Free trial feature limits are fixed by the platform and cannot be edited; choose trial_days 3, 7, or 10',
    });
  }
  return expected;
}
