import HTTP400Error from '@surefy/exceptions/HTTP400Error';

export function resolveTrialDays(billingCycle: string, trialDays?: unknown): 3 | 7 | 10 | null {
  if (billingCycle !== 'Free') {
    if (trialDays !== undefined && trialDays !== null) {
      throw new HTTP400Error({ message: 'trial_days is only supported for Free plans' });
    }
    return null;
  }
  if (trialDays === undefined) return 3;
  if (trialDays !== 3 && trialDays !== 7 && trialDays !== 10) {
    throw new HTTP400Error({ message: 'trial_days must be 3, 7, or 10 for Free plans' });
  }
  return trialDays;
}

export function getPlanDurationDays(plan: { billing_cycle: string; trial_days?: number | null }): number {
  if (plan.billing_cycle === 'Monthly') return 30;
  if (plan.billing_cycle === 'Yearly') return 365;
  return resolveTrialDays(plan.billing_cycle, plan.trial_days ?? undefined) ?? 3;
}


const DAY_MS = 24 * 60 * 60 * 1000;

// Calendar months/years clamp to the final day (Jan 31 -> Feb 28/29).
export function calculatePlanPeriod(plan: { billing_cycle: string; trial_days?: number | null }, start: Date, existing?: any) {
  const end = new Date(start);
  if (plan.billing_cycle === 'Monthly' || plan.billing_cycle === 'Yearly') {
    const day = start.getUTCDate();
    end.setUTCDate(1);
    if (plan.billing_cycle === 'Monthly') end.setUTCMonth(end.getUTCMonth() + 1);
    else end.setUTCFullYear(end.getUTCFullYear() + 1);
    const lastDay = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0)).getUTCDate();
    end.setUTCDate(Math.min(day, lastDay));
  } else if (plan.billing_cycle === 'Free') {
    end.setTime(start.getTime() + getPlanDurationDays(plan) * DAY_MS);
  } else {
    throw new HTTP400Error({ message: 'Unsupported billing cycle' });
  }
  // Preserve the existing day-for-day policy, without rounding partial days up.
  const remainingMs = existing?.active && existing.billing_cycle !== 'Free' && plan.billing_cycle !== 'Free'
    ? Math.max(0, new Date(existing.end_date).getTime() - start.getTime()) : 0;
  if (!Number.isFinite(remainingMs)) throw new HTTP400Error({ message: 'Invalid existing plan expiry' });
  end.setTime(end.getTime() + remainingMs);
  return { endDate: end, durationDays: Math.ceil((end.getTime() - start.getTime()) / DAY_MS), remainingDays: remainingMs / DAY_MS };
}
