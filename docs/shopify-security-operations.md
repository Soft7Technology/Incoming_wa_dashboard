# Soft7 Shopify data security procedures

Prepared 17 October 2026. Status: implementation evidence and operating procedure draft;
provider configuration, responsible staff assignments and operational adoption remain
to be verified. This document is not a completed Shopify compliance attestation.

## Control evidence and remaining actions

| Control | Evidence in this repository | Operator action before declaring compliance |
| --- | --- | --- |
| Minimum data and stated purpose | Allowlisted encrypted event inbox; optional Phone use for utility order messages | Align listing, merchant agreement and consent text with actual behavior |
| Consent and opt-outs | Explicit order attribute and send-time opt-out check; rules disabled by default | Install/test merchant consent capture and withdrawal; retain evidence |
| Retention and erasure | Minute privacy scheduler; bounded expiry; job/history linkage; privacy export and erasure | Monitor failures and deadlines; apply backup retention and restore-time erasure |
| Encryption at rest | Shopify payload/token/job application encryption | Verify database disks, linked ordinary WhatsApp message history, replicas, logs and provider backups are encrypted; application encryption does not cover every column |
| Encryption in transit | HTTPS public endpoints and upstream API calls | Current PostgreSQL connection has no TLS. Enable certificate-verified TLS or document an encrypted private network; do not disable certificate checks |
| Encrypted backups | Tested AES-256-GCM export encryption tool | Configure the provider's backups, access, retention, separate key custody and a scheduled restore drill; a tool alone does not encrypt provider snapshots |
| Environment separation | Isolated test fixtures; reviewer tenant isolated from other accounts | Use separate production database, storage, provider credentials and deployments; a separate tenant is not a separate environment |
| Staff access | Owner-only Shopify APIs; audit records | Named least-privilege staff identities; restrict database, host, backups and secret manager; revoke access promptly |
| Strong staff passwords | Registration/change/reset hashing and team password setup enforce at least 12 characters and at most 72 UTF-8 bytes | Migrate existing weak staff credentials and require strong passwords/MFA on infrastructure accounts; existing passwords were not changed |
| Access logs | Shopify event/export/completion audit records; raw authentication account/OTP/password-bearing debug logs removed | Restrict log access and review logs regularly; audit direct database and backup access through provider controls |
| Data loss prevention | Field minimization, scoped exports, safe Shopify provider-error logging, ignored secrets/runtime/backups | Restrict outbound export/storage permissions, alert on unusual access and prevent customer exports in shared mail/chat/source control |
| Incident response | Procedure below | Assign the incident lead, contacts and escalation path; run and record an exercise |

## Backups and restore

Use provider-managed encrypted backups where possible. Choose the shortest justified
retention (proposed: daily backups expiring after 7 days, subject to actual recovery
needs) and configure deletion in the provider. Keep keys in a separate secret manager,
restrict restore permission, and record access. This proposal has not configured a
backup schedule, encrypted any existing backup, or changed retention in a provider.

For separately exported database dumps, `scripts/shopify-backup.cjs` encrypts a file or
binary stdin with AES-256-GCM. Supply `SHOPIFY_BACKUP_ENCRYPTION_KEY` from the secret
manager: a separate random 32-byte base64 key, never the Shopify token encryption key.
Do not rotate the Shopify token key; existing records depend on it. Store encrypted
exports outside the repository on access-controlled backup storage.

```text
node scripts/shopify-backup.cjs encrypt <database-export.dump> <backup.dump.enc>
node scripts/shopify-backup.cjs decrypt <backup.dump.enc> <isolated-restore.dump>
```

Paths must be existing authorized operator directories; the tool never overwrites a
destination. Decryption authenticates the entire backup before publishing the restore
file. Temporary plaintext exists during decryption on that filesystem: use an encrypted
restricted volume, check Windows ACLs, and securely expire the restore volume after a
drill. A file mode alone does not establish Windows access controls. Use a trusted binary
stream runner if piping pg_dump; legacy Windows PowerShell can corrupt native binary
pipeline output. This workspace has no pg_dump executable configured.

Before restoring, isolate the environment from customers, Shopify and WhatsApp workers.
Maintain a separate encrypted record of erasure/uninstall requests for at least the
backup lifetime. Reapply deletions and retention cutoffs that happened after the backup,
cancel restored pending/stale send jobs, validate scoped access and inspect only test
records. Do not start traffic or workers until the incident lead authorizes recovery.
Record backup date, retention, encryption/key identifier, restore success and erasure
reapplication without including keys, phone numbers or message bodies in the record.

## Staff access and routine operation

Assign a named Soft7 operator for privacy and a named backup/incident owner. Use individual
accounts, least privilege and MFA where supported. Keep production customer data out of
development. Grant exceptional database/export access for a specific purpose and revoke
it immediately afterward. Review staff access monthly and on role changes/departure.

Daily: review privacy maintenance failures and pending/overdue requests; verify message
and privacy workers are running. Review suspicious exports and provider audit logs.
Complete customer access requests within the documented 30-day deadline; download all
export sections, deliver securely to the merchant and only then mark delivered.

Do not log passwords, OTP records, Shopify credentials, webhook destination tokens,
recipient numbers or message bodies. Store customer exports only temporarily in a
restricted location; never attach them to a Shopify review submission.

## Incident response procedure

1. Record discovery time, incident identifier and affected service. Notify the assigned
   incident lead and privacy contact through the internal escalation channel.
2. Contain exposure: suspend affected credentials/accounts and stop affected sends or
   exports. Isolate the affected environment without deleting evidence.
3. Preserve restricted evidence: access/audit records, relevant timestamps and deployment
   changes. Do not copy customer payloads or credentials into tickets or public logs.
4. Determine affected merchants, data categories, timeframe, unauthorized access and
   whether data was actually disclosed. Keep an access-controlled decision log.
5. Have the privacy lead assess contractual/platform and applicable notification duties
   and send required notices through the proper channels. Do not invent a universal
   notification deadline or wait for a full investigation when a deadline applies.
6. Revoke compromised sessions and provider credentials. Plan encryption-key rotation
   with migration/re-encryption and retained-backup recovery; never replace a live
   encryption key casually.
7. Patch the cause, verify isolated restore/deletion behavior, test least-privilege access
   and obtain incident-lead approval before restoring normal traffic.
8. Record corrective actions, owners and dates. Run a follow-up exercise and update the
   procedure. Keep evidence under an explicit restricted retention policy.

Reference: [Shopify protected customer data requirements](https://shopify.dev/docs/apps/launch/protected-customer-data#requirements).
