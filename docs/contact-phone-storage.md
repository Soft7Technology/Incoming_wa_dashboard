# Contact phone storage and import

Contacts store the full number with a leading `+` in `phone_number`. For example, `919372597458` becomes `+919372597458`, with `country_code: "91"`. Incoming-message contacts use the same normalization. Sending uses the existing recipient helper, which avoids adding the calling code twice.

## Optional country information

Excel/CSV imports do not require a country column. The phone library recognizes valid full international numbers with or without `+`. A row country_code or import country_code can resolve a local number; calling codes and ISO country identifiers are supported. There is no default Indian country code.

Numeric contacts whose country cannot be resolved are still saved: `9372597458` becomes `phone_number: "+9372597458"`, `country_code: null`, `is_valid: false`. Adding a leading plus preserves a consistent storage format; it does not establish that the number is internationally valid. These contacts need country information before sending. Malformed characters, unsafe numeric Excel cells, and numbers outside 4?15 digits remain invalid and are not imported.

## Editing phone and country

On `PUT /v1/admin/contacts/:id`, a non-empty `country_code` is authoritative. It accepts a calling code (`91`, `+91`) or ISO country (`IN`). Selecting it rebuilds `phone_number` with that prefix and saves the normalized code in `country_code`. For an unresolved contact, updating `+9896370801` with `country_code: "91"` saves `+919896370801` and `91`. Changing the country alone replaces a known saved prefix, rather than adding a second calling code.

Numeric but invalid contacts can still be edited and assigned. A changed phone is revalidated; an invalid result uses `invalid_reason: "invalid_format"`. Profile or assignment updates that resend the same phone and country preserve existing validation and WhatsApp failure flags. Duplicate resulting identities are rejected within the account and sending number. Phone format validation does not confirm WhatsApp registration.

## Preview API

POST `/v1/admin/contacts/import/preview` using multipart form-data with one `file`. Optional fields: `phone_column`, `name_column`, `email_column`, `country_code`.

The response retains headers, raw preview and total_rows, and includes:

- `valid_count`: numbers recognized by the phone library.
- `needs_country_count`: numeric contacts saved without a resolved country.
- `importable_count`: valid_count + needs_country_count, before duplicate handling.
- `invalid_count`: malformed rows excluded from import.
- `normalized_preview`: up to five importable contacts in their storage format.
- `needs_country`: importable contacts requiring country information.
- `errors`: malformed rows and their reasons.

Actual import uses the same parser. Unresolved contacts are included in import, not in failed counts. Validation does not confirm WhatsApp registration or database uniqueness.

## Background import

`POST /v1/admin/contacts/import` validates the uploaded file and column mappings, records an import job, and enqueues it in the existing `contact-import` BullMQ queue. It returns HTTP `202` with `job_id`, `status: "queued"`, `total_rows`, and `progress_percentage`. Contact creation, updates, plan checks, list membership, tags, and row results run in the contact import worker.

Poll `GET /v1/admin/contacts/import/:jobId/status` for `status`, progress, successful/failed rows, errors, and the final `result`. Final counts are available when the job is completed. Historical imports with `execution_mode: "api"` remain readable. An enqueue failure marks the import record failed and returns an error.

Run `npm run start:worker` alongside the API in production, or `npm run worker` during development. API and worker must use the same Redis configuration and have access to the same uploaded files at the saved paths. The current Docker entrypoint runs both processes in one container. Separate containers need a shared upload volume at the same path. This change requires no database migration.

All backend workers start from one entry point: `src/workers/index.ts`, compiled to `dist/src/workers/index.js`. The single `npm run start:worker` command starts `contact-import`, `campaign-execution`, `bulk-message-send`, and `chatbot-delay`, plus the reminder scheduler. The API enqueues imports and this shared worker process consumes them. SIGTERM/SIGINT drains every consumer and the scheduler before closing database/shared Redis connections. Launching the compiled entry point directly with Node also sets worker mode before database initialization.

### Kubernetes combined workers

To deploy from this backend checkout without using `kubectl edit`, build/publish the backend production image and run:

```bash
KUBECONFIG=/etc/kubernetes/admin.conf sh scripts/deploy-workers.sh YOUR_PUBLISHED_BACKEND_IMAGE
```

Replace the image argument with the actual image reference. The script updates the existing `wa-dashboard` container in the `default/contact-worker` deployment to run all backend workers with `npm run start:worker` and image pull policy `IfNotPresent`, waits for rollout, and prints logs. The existing deployment name is retained. `WORKER_DEPLOYMENT`, `WORKER_NAMESPACE`, `WORKER_CONTAINER`, and `WORKER_IMAGE_PULL_POLICY` override these defaults. Existing environment variables, volumes, resources, and probes are retained. The worker must use the API's database/Redis settings and uploaded-file paths. Keep the same settings in your release manifests or Helm values. Existing separate Kubernetes deployments continue running until explicitly changed; this script only updates the selected deployment.

For a single-node containerd cluster, build the production image with Docker, export it with `docker save -o /tmp/workers-image.tar incoming-api:workers-20261012`, then import it into Kubernetes' containerd namespace using `ctr -n k8s.io images import /tmp/workers-image.tar`. Deploy with the same image tag. Use a fresh tag for each build so `IfNotPresent` does not select an older cached image. On a multi-node cluster, import on every eligible node or publish the image to a registry instead.

A deployment named `contact-worker` that runs `worker:webhook` is running a webhook consumer. Build and deploy matching backend/API code with the shared worker entry point. If the old deployment is the only webhook consumer, keep it running in a separate deployment when repurposing it.

For a manually maintained worker deployment, set the selected container's startup command to:

```yaml
command: ["npm"]
args: ["run", "start:worker"]
```

Expect `[Workers] Started` listing all four queues and the contact worker ready log. Review inherited startup/readiness/liveness probes: this worker does not expose an HTTP server. Set the pod termination grace period to allow active jobs to drain before Kubernetes forces termination.

Worker retries reuse the import's recorded list, and completed jobs return their saved results if delivered again. List creation and its job association commit in one transaction; tag counts are recalculated once per tag from saved relations before completion.

## Deployment

Apply pending migrations through `20260930000003_allow_unresolved_contact_phones.ts` with API and workers stopped, then deploy matching code together. The new migration makes country_code nullable, normalizes existing contacts, and preserves company/owner/business-number uniqueness. Duplicate normalized identities cause the migration to fail before rewriting rows. Earlier pending migrations still run their existing preflight checks and may require data cleanup first.

No database migration was executed during this change. Back up existing data before migration. Automated rollback of the new migration is intentionally blocked because unresolved contacts cannot be converted safely into mandatory split-country storage.

## Campaign recipient override

Campaigns accept numeric recipients without a separate country_code. Unresolved numbers are preserved and attempted without guessing a country. Campaign creation includes these contacts by default; explicitly setting contact_filters.exclude_invalid to true excludes contacts marked is_valid=false. Malformed input remains rejected. Opt-outs and recorded invalid-number failures still prevent sending. This permissive sending behavior is limited to the internal campaign send path; ordinary message API validation is unchanged. Meta may reject an unresolved number, in which case the campaign records the failure.
## Database availability

See [background database failure handling](background-database-errors.md) for schema checks, backoff, recovery and Kubernetes database diagnosis.
