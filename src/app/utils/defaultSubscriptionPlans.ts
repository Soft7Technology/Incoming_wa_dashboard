import { subscriptionPlans } from '../interfaces/subscription.interface';
import { freeTrialFeatures, newTrialDays } from './freeTrialPolicy';
import { normalizeFeatures } from './planFeatures';

/** Trusted registration defaults. Every call returns independent plan/feature objects. */
export function defaultSubscriptionPlans(trialDays?: unknown): subscriptionPlans[] {
  const days = newTrialDays(trialDays);
  return [
    {
      plan_name: 'Free', price: 0, billing_cycle: 'Free', trial_days: days,
      description: 'Try the platform with fixed limits', active: true,
      features: freeTrialFeatures(),
      marketing_features: [`${days}-day free trial`, '500 contacts', '2 campaigns', 'No payment required'],
    },
    {
      plan_name: 'Basic', price: 99, billing_cycle: 'Monthly', trial_days: null,
      description: 'Essential tools for small businesses', active: false,
      features: normalizeFeatures({
        TeamInvite: { limit_value: 2 }, Contact: { limit_value: 5000 },
        Campaign: { limit_value: 20, reset_period: 'monthly' }, WabaNumber: { limit_value: 1 },
        Chatbot: { limit_value: 2 }, AiAssistant: { limit_value: 1 },
        developer_api: { enabled: false, limit_value: 0 },
      }),
      marketing_features: ['5,000 contacts', '20 campaigns per month', '2 team members', '1 WhatsApp number'],
    },
    {
      plan_name: 'Pro', price: 200, billing_cycle: 'Monthly', trial_days: null,
      description: 'More capacity and automation for growing businesses', active: false,
      features: normalizeFeatures({
        TeamInvite: { limit_value: 2 }, Contact: { limit_value: 20000 },
        Campaign: { limit_value: null, reset_period: 'monthly' }, WabaNumber: { limit_value: 3 },
        Chatbot: { limit_value: 10 }, AiAssistant: { limit_value: null },
        developer_api: { enabled: true, limit_value: 1 },
      }),
      marketing_features: ['20,000 contacts', 'Unlimited campaigns', '3 WhatsApp numbers', '10 chatbots', 'Unlimited AI assistants'],
    },
    {
      plan_name: 'Enterprise', price: 999, billing_cycle: 'Monthly', trial_days: null,
      description: 'Higher capacity for larger teams', active: false,
      features: normalizeFeatures({
        TeamInvite: { limit_value: 10 }, Contact: { limit_value: 100000 },
        Campaign: { limit_value: null, reset_period: 'monthly' }, WabaNumber: { limit_value: 10 },
        Chatbot: { limit_value: 50 }, AiAssistant: { limit_value: null },
        developer_api: { enabled: true, limit_value: 1 },
      }),
      marketing_features: ['100,000 contacts', '10 team members', 'Unlimited campaigns', '10 WhatsApp numbers', '50 chatbots', 'Unlimited AI assistants'],
    },
  ];
}
