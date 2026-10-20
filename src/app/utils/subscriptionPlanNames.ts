import HTTP400Error from '@surefy/exceptions/HTTP400Error';

export const SUBSCRIPTION_PLAN_NAMES = Object.freeze(['Free', 'Basic', 'Pro', 'Enterprise'] as const);

export function validateSubscriptionPlanName(value: unknown) {
  if (typeof value !== 'string' || !SUBSCRIPTION_PLAN_NAMES.some(name => name === value)) {
    throw new HTTP400Error({ message: 'plan_name must be Free, Basic, Pro, or Enterprise',
      details: { code: 'INVALID_PLAN_NAME', allowed_values: [...SUBSCRIPTION_PLAN_NAMES] } });
  }
}

export function subscriptionPlanOptions() {
  return {
    plan_names: SUBSCRIPTION_PLAN_NAMES.map(name => ({ label: name, value: name })),
    custom_names_allowed: false,
  };
}
