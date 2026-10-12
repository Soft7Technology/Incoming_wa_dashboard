# Campaign workers

Run the API and `npm run worker` in development. Production: apply database migrations, build with `npm run build`, then run `npm run start:worker` with your environment variables loaded. The API enqueues work; a separate worker must be running against the same Redis database. Restart both processes after updating the code. If the API reports `EADDRINUSE`, another process owns its port; stop that instance or configure another port.

This one worker command runs `dist/src/workers/index.js`, which starts the `campaign-execution`, `contact-import`, `bulk-message-send`, and `chatbot-delay` consumers and the reminder scheduler together. Contact imports use the same worker process as campaigns; there is no separate contact-worker startup command.

See [background database failure handling](background-database-errors.md) for worker readiness checks, bounded retries, API 503 responses and Kubernetes database diagnosis. A missing table or column needs the correct database configuration and migrations; runtime guards leave waiting jobs available while that is repaired.

Configuration (same values across replicas):

```
CAMPAIGN_CONCURRENCY=4
CAMPAIGN_MAX_BATCH_SIZE=10
CAMPAIGN_MESSAGE_CONCURRENCY=2
CAMPAIGN_MAX_RUNNING_PER_USER=4
CAMPAIGN_MESSAGES_PER_SECOND=10
DB_POOL_MAX=5
BULK_MESSAGE_CONCURRENCY=2
```

The batch size starts at 4 and adapts to sampled host CPU, memory pressure and event-loop delay. It can grow while host memory is below 90% and shrinks at 95% or above. Each campaign processes at most `CAMPAIGN_MESSAGE_CONCURRENCY` recipients at once; batch size controls how many are selected, not how many database operations start together. Redis limits active campaigns per owner with `CAMPAIGN_MAX_RUNNING_PER_USER` across worker replicas; excess jobs stay delayed until a slot is free. A slot has a renewable lease, so a worker crash releases it after two minutes. Database connection-acquisition timeouts delay the current batch by 30 seconds without failing pending recipients or exhausting BullMQ attempts. A successful batch immediately starts the next batch; only provider limits, deferred recipients, infrastructure pressure, or an explicit pause delay an active campaign. Redis pacing shares the configured sender limit across campaign workers; the default is at most 600 messages per minute per business phone. Recipient pairs are spaced by six seconds. These are application limits, not a guarantee of Meta entitlement. Direct messages, chatbot traffic and other senders using the account are outside this campaign limiter: leave headroom and configure according to your account allowance. `DB_POOL_MAX` caps connections per Node process, defaults to 15, and should be set on both API and worker processes. Count every API and worker replica when setting it; for example, four processes at `DB_POOL_MAX=5` can use up to 20 PostgreSQL connections, before other clients.

Provider failures, including rate-limit responses, leave attempted recipients terminally failed; they are not resent automatically. Application pacing can defer an unattempted recipient using `retry_after`. By default, four campaigns for one owner can be active on one worker. Set `CAMPAIGN_CONCURRENCY` and `CAMPAIGN_MAX_RUNNING_PER_USER` to at least the desired simultaneous campaign count on the VPS; explicit lower values override the defaults. Across worker replicas, `CAMPAIGN_MAX_RUNNING_PER_USER` remains a shared limit, while `CAMPAIGN_CONCURRENCY` applies to each worker process. Four active campaigns share the configured per-phone send rate; starting them together does not multiply a phone number's Meta throughput allowance. Keep aggregate message concurrency and DB_POOL_MAX within the database connection budget.

Apply the `add_campaign_message_retry_after` migration before deploying the current worker. A blocked recipient receives its own `campaign_messages.retry_after` time, so the campaign continues sending to other recipients and only waits if every remaining recipient is deferred. Worker logs show `Waiting for deferred recipients` in that case.
Campaign recipient retries and rebroadcast are disabled. Pre-send deferral does not retry a recipient that has already been attempted.

The combined worker process also runs bulk-message jobs. They now use one job with at most two concurrent sends by default; `BULK_MESSAGE_CONCURRENCY` can be set from 1 to 10. This prevents a 50-message bulk batch from monopolizing the same Knex pool used by campaign jobs. The campaign progress endpoint reports `pending_count` and `deferred_count` to distinguish queued recipients from those waiting for cooldown.

Immediate campaigns are queued as soon as their recipient rows have been saved, without a fixed startup delay. The scheduler checks other due campaigns every five seconds. Queue contention, provider restrictions and infrastructure outages can still delay execution. CPU and available memory are host metrics; container limits may require a lower configured maximum batch size.

Look for these console events:
- `Start requested` / `Existing job`: campaign ID and BullMQ state. An active job is not duplicated.
- `Health` every 15 seconds: PID, host CPU percentage, process CPU percentage (100 means one core), host memory percentage, process RSS MB, event-loop p95 milliseconds, batch size, queue counts (active, waiting, delayed, failed), concurrency and sender rate limit. If active, waiting and delayed are zero, this worker has no queued campaign work. The scheduler preserves campaigns with missing jobs for review rather than automatically requeueing them.
- `Batch starting` / `Batch finished`: campaign/job ID, attempt, selected recipient count, rejected count, elapsed milliseconds, pending count, progress and error counts. Selected is not the count of successful sends; rate-limited recipients can remain pending. Full status counts are calculated at completion to avoid a join across the entire campaign after every batch.
- `Waiting for schedule`, `Finished`, `Execution error` and `Job stalled`: lifecycle and recovery details.

Individual recipient failures remain visible while the campaign continues. Once every pending recipient has been processed, the campaign is completed even if some or all recipients failed. Database outages stop new work or defer it for connection pressure. Campaign jobs discard automatic retries, including attempts configured on older jobs. Starting an eligible campaign can resume unattempted pending recipients; it does not reset attempted recipients or rebroadcast failures. Review failed jobs before restarting work.

After applying the `add_campaign_failure_reason` migration, terminal job errors are stored in `campaigns.failure_reason` and returned by the campaign progress and stats endpoints. Starting the campaign again clears the previous reason. Recipient errors belong to individual `campaign_messages` rows and do not set the campaign failure reason.

Workers drain active jobs before closing the database on SIGINT/SIGTERM. Give your process manager sufficient termination grace for outbound requests. A terminal reservation is saved before sending a campaign recipient. If Meta's acknowledgement cannot be saved, the recipient remains failed/unconfirmed and is excluded from automatic replay. This does not provide exactly-once delivery or guarantee successful delivery after a crash.

Validation: `node --test tests/background-database.test.cjs tests/background-worker-errors.test.cjs tests/campaign-no-retry.test.cjs tests/campaign-send-once.test.cjs` and `npm run build`. Tests use mocked dependencies and send no messages. The older `campaign-worker.test.cjs` also contains expectations from the former retry/rebroadcast policy.

## Campaign recipient selection

Campaign recipient numbers are selected from contacts owned by the campaign user and company and connected to the payload sender's internal phone number ID. Contacts connected to another sender are excluded. Explicit contactNumber inputs reuse saved country-code context only for that sender; new external numbers retain existing auto-create behavior. The campaign payload phone_number_id selects the sending number. Creation validates its user/company ownership, and the worker rechecks ownership before executing. Sender-specific opt-outs remain enforced.

If no eligible recipients match, creation returns HTTP 400 before saving a campaign, campaign messages, consuming campaign quota or queueing a send. The response message explains whether selected numbers did not match filters, all matching recipients opted out, or selected tag names could not be found. Error details include CAMPAIGN_NO_MATCHING_CONTACTS, CAMPAIGN_CONTACTS_OPTED_OUT or CAMPAIGN_CONTACT_TAGS_NOT_FOUND. Frontends should display the API message from the failed creation response. Contacts may still be auto-created for new explicit numbers before later filter validation rejects the campaign.
