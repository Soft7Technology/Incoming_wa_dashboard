# Campaign workers

Run the API and `npm run worker` in development. Production: build with `npm run build`, then run `npm run start:worker` with your environment variables loaded. The API enqueues work; a separate worker must be running against the same Redis database. Restart both processes after updating the code.

Configuration (same values across replicas):

```
CAMPAIGN_CONCURRENCY=4
CAMPAIGN_MAX_BATCH_SIZE=10
CAMPAIGN_MESSAGES_PER_SECOND=10
```

The batch size starts at 2 and adapts to sampled host CPU, memory pressure and event-loop delay. Each campaign yields between batches. Redis pacing shares the configured sender limit across campaign workers; the default is at most 600 messages per minute per business phone. Recipient pairs are spaced by six seconds. These are application limits, not a guarantee of Meta entitlement. Direct messages, chatbot traffic and other senders using the account are outside this campaign limiter: leave headroom and configure according to your account allowance. More worker replicas increase total database connections; cap replicas to database capacity.

The scheduler checks due campaigns every five seconds. Queue contention, provider restrictions and infrastructure outages can delay execution. CPU and available memory are host metrics; container limits may require a lower configured maximum batch size.

Look for these console events:
- `Start requested` / `Existing job`: campaign ID and BullMQ state. An active job is not duplicated.
- `Health` every 15 seconds: PID, host CPU percentage, process CPU percentage (100 means one core), host memory percentage, process RSS MB, event-loop p95 milliseconds, batch size, concurrency and sender rate limit.
- `Batch starting` / `Batch finished`: campaign/job ID, attempt, selected recipient count, rejected count, elapsed milliseconds, progress and database status counts. Selected is not the count of successful sends; rate-limited recipients can remain pending.
- `Waiting for schedule`, `Finished`, `Execution error`, `Provider rate limit` and `Job stalled`: lifecycle and recovery details.

Individual recipient failures remain visible in the failed count and recipient details while the campaign continues. A provider rate-limit response delays the next batch for 30 seconds; repeated recipient errors do not pause the campaign. Once every pending recipient has been processed, the campaign is completed even if some or all recipients failed. Infrastructure execution errors use BullMQ retries; exhausted execution retries still mark a running campaign failed. The start endpoint can recover a running campaign with a missing or failed job and replaces a paused waiting job. Starting does not resend recipients already marked sent; retry-failed uses the rebroadcast path.

Workers drain active jobs before closing the database on SIGINT/SIGTERM. Give your process manager sufficient termination grace for outbound requests. Abrupt termination after Meta accepts a message but before its database status is saved still risks a duplicate on recovery; this implementation does not provide exactly-once delivery.

Validation: `node --test tests/campaign-worker.test.cjs` and `npx tsc --noEmit`. Tests use mocked dependencies and send no messages.
