export interface subscriptionPlans {
  plan_name: string;
  company_id?: string;
  user_id?: string;
  price: number;
  billing_cycle: "Monthly" | "Yearly" | "Free";
  trial_days?: 3 | 7 | 10 | null;
  description: string;
  active: boolean;
  /** Display text shown on plan cards; does not grant access or increase limits. */
  marketing_features?: string[];

  features: {
    [key: string]: {
      limit_type?: string;
      limit_value: number | null;
      enabled?: boolean;
      reset_period?: 'never' | 'monthly' | 'yearly';
    };
  };
}

// Plan Name
// Price
// Billing Cycle
// Desciprition
// Active(to user) boolean value
// Mark as popular  boolean value
// Feature &Limits
// Feature Label:- campaign automatuib
// Limit Type: Campaign/month
// Limit Value
