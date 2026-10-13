# Contact import job status

Contact imports use the existing `contact-import` consumer in the combined worker. No additional worker or database migration is required for these status fields. Deploy matching API and worker code and keep their database, Redis and shared upload storage settings consistent.

## Start an import

Send `POST /v1/admin/contacts/import` with the existing JWT and multipart fields `file`, `list_name`, `phone_number_id`, plus optional country, column mappings and tag IDs. A successful enqueue returns HTTP 202:

```json
{
  "success": true,
  "message": "Contact import queued. Check the job status for progress and results.",
  "data": {
    "job_id": "8a2b0b08-47b8-4a6b-8d64-320ceff5a3d4",
    "status": "queued",
    "total_rows": 2000,
    "progress_percentage": 0,
    "status_url": "/v1/admin/contacts/import/8a2b0b08-47b8-4a6b-8d64-320ceff5a3d4/status",
    "poll_after_ms": 2000
  }
}
```

Keep the job ID and status URL in frontend state. The upload response accepts work; the imported contacts and list are ready when the job reaches `completed`.

## Check progress

```http
GET /v1/admin/contacts/import/YOUR_JOB_ID/status
Authorization: Bearer YOUR_JWT_TOKEN
```

Poll every two seconds using the JWT that owns the import account. Account team members use their authenticated owner/company scope. An import from another account, a deleted import or a missing import returns 404. Responses use `Cache-Control: no-store`.

Example processing response (existing timestamps, error and result fields are also retained):

```json
{
  "success": true,
  "message": "Import job status retrieved successfully",
  "data": {
    "id": "8a2b0b08-47b8-4a6b-8d64-320ceff5a3d4",
    "job_id": "8a2b0b08-47b8-4a6b-8d64-320ceff5a3d4",
    "status": "processing",
    "database_status": "processing",
    "stage": "importing",
    "progress": 50,
    "progress_percentage": 50,
    "total_rows": 2000,
    "processed_rows": 1000,
    "successful_rows": 990,
    "failed_rows": 10,
    "skipped_rows": 0,
    "remaining_rows": 1000,
    "valid_count": 1980,
    "invalid_count": 10,
    "needs_country_count": 10,
    "importable_count": 1990,
    "duplicate_count": 100,
    "unique_count": 1890,
    "created_count": 900,
    "updated_count": 90,
    "elapsed_seconds": 30,
    "processing_elapsed_seconds": 20,
    "estimated_remaining_seconds": 10,
    "retry_pending": false,
    "attempts_made": 0,
    "max_attempts": 3,
    "queue_status": "available",
    "bull_job_state": "active",
    "status_url": "/v1/admin/contacts/import/8a2b0b08-47b8-4a6b-8d64-320ceff5a3d4/status",
    "poll_after_ms": 2000
  }
}
```

`progress` and `progress_percentage` are aliases. Progress is capped at 99 until tag counts, list updates and completion persistence finish. During row processing, the worker publishes durable counters at most once per two seconds as rows finish, and at batch boundaries. It does not write progress for every row.

## Valid, invalid and duplicate counts

The same status endpoint exposes these fields at the top level of `data`, and completed jobs include them in `data.result`:

| Field | Meaning |
| --- | --- |
| `valid_count` | Rows with recognized valid full phone numbers, using the same rules as import preview. |
| `invalid_count` | Malformed or otherwise rejected phone rows from parsing. This excludes database/write failures. |
| `needs_country_count` | Importable numeric rows whose country cannot be resolved. These are saved with `is_valid: false`. |
| `importable_count` | All rows accepted by the parser, including duplicates and rows needing country information. |
| `duplicate_count` | Repeated normalized phone numbers in the uploaded file after their first occurrence. Three rows with the same normalized number count as two duplicates. |
| `unique_count` | Distinct normalized phone numbers among importable rows. |
| `created_count` | Successful rows that created a contact during the current worker attempt. |
| `updated_count` | Successful rows that matched and updated a saved contact during the current attempt. Includes repeats of a contact created earlier in the same attempt. |

Formatting variants that normalize to the same full phone number count as duplicates. These counters preserve the current import behavior: duplicate rows still update contacts and join the selected list/tags. `duplicate_count` measures repeats within the file; matches to already-saved account contacts are represented by `updated_count`.

File classification counts become available after parsing and remain stable across retries. Creation/update counts advance with the existing progress snapshots and reset for a new attempt; a retry can update contacts created by its previous attempt. `created_count + updated_count` equals the current attempt's `successful_rows`. `unique_count + duplicate_count` equals `importable_count`. Valid/invalid/country counts describe the full file, while creation/update counts describe processed outcomes. Duplicate counts overlap valid and needs-country counts; do not add them to obtain total rows. `failed_rows` includes rejected phone rows and failures writing otherwise importable rows, so it can exceed `invalid_count`.

Before parsing, unavailable counts are null. Older jobs also return null for counts that were never recorded, while retaining their existing result's invalid/country counts. No extra per-row database queries or schema migration are needed for these statistics. The counters do not verify that a number has a WhatsApp account.

`elapsed_seconds` counts from import creation, including queue wait and retries. `processing_elapsed_seconds` counts from the current attempt's start; it is null while queued. Completed and failed terminal jobs freeze elapsed time at their saved finish timestamp. Missing historical timestamps produce null timing fields.

`estimated_remaining_seconds` uses the average rate of attempted importable rows in the current attempt. Already-invalid parsed rows are excluded from this rate. The estimate excludes future queue waiting, retries, parsing and final tag/list persistence. It is null during `preparing`, `saving` or queue wait, before a useful sample exists, after failure, and after ten seconds without a fresh progress sample. Show the stage or `Calculating...` when it is null. Completion returns an estimate of 0 and progress of 100.

## Retries and final results

Stages include `queued`, `retrying`, `preparing`, `importing`, `saving`, `completed`, `failed` and `cancelled`.

A failed attempt with another attempt queued returns `status: "queued"`, `stage: "retrying"` and `retry_pending: true`. `database_status` preserves the last stored state for diagnosis. Counters reset when the next attempt starts; completed jobs are not imported again on redelivery. `attempts_made` counts finished attempts and may be null when queue metadata is unavailable.

- On `completed`, stop polling and use `data.result`, including `list_id`, `imported`, `failed`, `skipped`, `total` and row errors. Completion can include rejected rows; inspect `failed_rows` and `result.errors`.
- On terminal `failed`, use `error_message` and any saved partial counts; fix the cause before submitting another import.
- On `cancelled`, stop polling.

Database progress remains readable during Redis outages. `queue_status: "unavailable"` means the queue could not be checked; it does not mean the import was cancelled. When the stored status is failed and Redis is unavailable, `retry_pending` is null and the response retains a polling interval: continue checking until retry state is known. An absent Redis job uses `queue_status: "missing"` and the saved database status. Completed and historical API imports use `queue_status: "not_required"`; their result does not depend on Redis retention. Polling does not restart or enqueue jobs.

Use `GET /v1/admin/contacts/import/jobs` with the same JWT to retrieve your account's import history. Each record's `id` can be used as the job ID for the status API. Existing filters include `status` and `job_type`.

Validation: `node --test tests/contact-import-status.test.cjs tests/contact-import-worker.test.cjs tests/import-job-json.test.cjs tests/startup-env.test.cjs tests/import-phone.test.cjs` and `npm run build`. Tests include real CSV phone normalization, retries with existing contacts, and local HTTP handling with simulated authentication context and mocked database/Redis dependencies; no contacts are written to a real database.
