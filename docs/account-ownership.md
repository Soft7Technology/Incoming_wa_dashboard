# Account ownership

WABA accounts, business phone numbers, and contacts belong to the authenticated
account owner (`req.ownerId ?? req.userId`). Company is an additional boundary,
never an alternative to the owner condition. Team members use their owner's
account; contact reads and deletes also require assignment to the member.

Do not accept owner or company overrides from request bodies. WABA onboarding
must not transfer an existing connection. Phone sync/new phone creation inherits
the WABA owner. Incoming contacts inherit the receiving phone owner, including
the chatbot path. Company membership alone no longer grants access to another
owner's WABA, phone numbers, contacts, or chatbot flow.

Contact identity is `(company_id, user_id, phone_number_id, normalized phone)`
for non-deleted records. Identical contact numbers under different owners are
intentional separate records. The migration adds a unique expression index and
owner-first listing indexes, and removes the original company-wide contact
phone constraint. It does not delete or reassign data.

## Deployment

1. Check existing phone ownership against parent WABAs and identify records with
   missing owners. Resolve ownership using actual account history; never assign
   all company records to the current user. Existing mismatched records will
   no longer appear in owner-scoped lists.
2. Identify duplicates for the new identity below. Consolidate history, list/tag
   relationships, and assignments before removing any duplicate records.
3. Run the normal migration process in a maintenance window. The migration's
   index build is transactional and can block writes on large tables. It fails
   if duplicates exist. No live migration was run as part of this code change.
4. Deploy/restart API and workers together. Test two owners in the same company,
   another company, and a team member. Test manual creation, imports, incoming
   messages, WABA onboarding/sync, and bulk deletion.

```sql
SELECT company_id, user_id, phone_number_id,
       regexp_replace(phone_number, '[^0-9]', '', 'g') AS normalized_phone,
       count(*)
FROM contacts
WHERE deleted_at IS NULL
GROUP BY company_id, user_id, phone_number_id,
         regexp_replace(phone_number, '[^0-9]', '', 'g')
HAVING count(*) > 1;
```

API changes: `/contacts/phone-number/:phoneNumberId` is the explicit phone list
route; the existing `/:phoneNumberId` route remains available. Contact detail is
`/contacts/by-id/:id` (the previous `/:id` route was shadowed by the phone route).
`/contacts/user/:userId` accepts only the current account/member and returns a
paginated contact result. Requests without user/company context are rejected.

Existing company-only API-key integrations must resolve an authenticated owner
before calling these account-scoped routes. Internal Meta-ID lookups remain
available for webhook routing; never expose their unscoped result directly in
an authenticated user endpoint without verifying ownership.

Rollback of the contact uniqueness migration can fail once different owners
have saved the same phone number in one company: the old company-wide identity
cannot represent those records. Review and consolidate before rolling back.
