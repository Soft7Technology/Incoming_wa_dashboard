# Free trial duration

Run `npm run migrate:latest` before using the updated API.

Create a plan with `POST /subscription/plan` or edit one with `PUT /subscription/plan/:id` under the existing admin route prefix. Set `billing_cycle` to `Free` and `trial_days` to the number `3`, `7`, or `10`.

Example duration-only update:

```json
{ "trial_days": 7 }
```

New Free plans default to 3 days when omitted. Existing Free plans are backfilled to 3 days. Partial updates preserve the current duration. Paid plans cannot specify trial days; switching to Monthly or Yearly clears the duration.

Plan reads include `trial_days`. Activating the plan uses this value for the new user plan duration and expiry. Changing a plan definition affects future activations only; existing user plan expiry dates are preserved. The existing one-trial eligibility check remains in effect.
