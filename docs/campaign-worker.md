# Campaign workers

Run the API and `npm run worker` in development. Production: apply database migrations, build with `npm run build`, then run `npm run start:worker` with your environment variables loaded. The API enqueues work; a separate worker must be running against the same Redis database. Restart both processes after updating the code. If the API reports `EADDRINUSE`, another process owns its port; stop that instance or configure another port.

Configuration (same values across replicas):

```
CAMPAIGN_CONCURRENCY=2
CAMPAIGN_MAX_BATCH_SIZE=10
CAMPAIGN_MESSAGE_CONCURRENCY=2
CAMPAIGN_MAX_RUNNING_PER_USER=2
CAMPAIGN_MESSAGES_PER_SECOND=10
DB_POOL_MAX=5
BULK_MESSAGE_CONCURRENCY=2
```

The batch size starts at 4 and adapts to sampled host CPU, memory pressure and event-loop delay. Each campaign processes at most `CAMPAIGN_MESSAGE_CONCURRENCY` recipients at once; batch size controls how many are selected, not how many database operations start together. Redis limits active campaigns per owner with `CAMPAIGN_MAX_RUNNING_PER_USER` across worker replicas; excess jobs stay delayed until a slot is free. A slot has a renewable lease, so a worker crash releases it after two minutes. Database connection-acquisition timeouts delay the current batch by 30 seconds without failing pending recipients or exhausting BullMQ attempts. Each campaign yields between batches. Redis pacing shares the configured sender limit across campaign workers; the default is at most 600 messages per minute per business phone. Recipient pairs are spaced by six seconds. These are application limits, not a guarantee of Meta entitlement. Direct messages, chatbot traffic and other senders using the account are outside this campaign limiter: leave headroom and configure according to your account allowance. `DB_POOL_MAX` caps connections per Node process, defaults to 15, and should be set on both API and worker processes. Count every API and worker replica when setting it; for example, four processes at `DB_POOL_MAX=5` can use up to 20 PostgreSQL connections, before other clients.

Provider rate-limit responses keep the affected campaign recipient pending and retry after a cooldown. Throughput limits cool down the shared business phone; pair-limit responses cool down only that sender-recipient pair. Set CAMPAIGN_MAX_RUNNING_PER_USER=2 or higher on the VPS if multiple campaigns for one owner should progress together; an explicit value of 1 serializes them. Keep CAMPAIGN_CONCURRENCY and DB_POOL_MAX within the database connection budget.

Apply the `add_campaign_message_retry_after` migration before deploying the current worker. A blocked recipient receives its own `campaign_messages.retry_after` time, so the campaign continues sending to other recipients and only waits if every remaining recipient is deferred. Worker logs show `Waiting for deferred recipients` in that case.
Meta pair-limit responses are retried up to ten times for that recipient; if they persist, that recipient is recorded as failed so it cannot hold the campaign open indefinitely.

The combined worker process also runs bulk-message jobs. They now use one job with at most two concurrent sends by default; `BULK_MESSAGE_CONCURRENCY` can be set from 1 to 10. This prevents a 50-message bulk batch from monopolizing the same Knex pool used by campaign jobs. The campaign progress endpoint reports `pending_count` and `deferred_count` to distinguish queued recipients from those waiting for cooldown.

The scheduler checks due campaigns every five seconds. Queue contention, provider restrictions and infrastructure outages can delay execution. CPU and available memory are host metrics; container limits may require a lower configured maximum batch size.

Look for these console events:
- `Start requested` / `Existing job`: campaign ID and BullMQ state. An active job is not duplicated.
- `Health` every 15 seconds: PID, host CPU percentage, process CPU percentage (100 means one core), host memory percentage, process RSS MB, event-loop p95 milliseconds, batch size, concurrency and sender rate limit.
- `Batch starting` / `Batch finished`: campaign/job ID, attempt, selected recipient count, rejected count, elapsed milliseconds, pending count, progress and error counts. Selected is not the count of successful sends; rate-limited recipients can remain pending. Full status counts are calculated at completion to avoid a join across the entire campaign after every batch.
- `Waiting for schedule`, `Finished`, `Execution error`, `Provider rate limit` and `Job stalled`: lifecycle and recovery details.

Individual recipient failures remain visible in the failed count and recipient details while the campaign continues. Provider throughput responses delay the sender for 30 seconds, while pair-limit responses delay only the recipient pair for six seconds; repeated recipient errors do not pause the campaign. Once every pending recipient has been processed, the campaign is completed even if some or all recipients failed. Infrastructure execution errors use BullMQ retries; exhausted execution retries still mark a running campaign failed. The start endpoint can recover a running campaign with a missing or failed job and replaces a paused waiting job. Starting does not resend recipients already marked sent; retry-failed uses the rebroadcast path.

After applying the `add_campaign_failure_reason` migration, terminal job errors are stored in `campaigns.failure_reason` and returned by the campaign progress and stats endpoints. Starting the campaign again clears the previous reason. Recipient errors belong to individual `campaign_messages` rows and do not set the campaign failure reason.

Workers drain active jobs before closing the database on SIGINT/SIGTERM. Give your process manager sufficient termination grace for outbound requests. Abrupt termination after Meta accepts a message but before its database status is saved still risks a duplicate on recovery; this implementation does not provide exactly-once delivery.

Validation: `node --test tests/campaign-worker.test.cjs` and `npx tsc --noEmit`. Tests use mocked dependencies and send no messages.
