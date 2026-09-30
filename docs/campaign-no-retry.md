# Campaign no-retry policy

Campaign job failures are not automatically retried (one attempt, discard on processor entry for older queued jobs, and no stalled-job recovery attempts). A missing queue lookup no longer marks a running campaign failed or enqueues another job. A failed queue job cannot override a live campaign execution lock. Failed campaigns may be started to continue pending, never-attempted recipients only; rebroadcast remains disabled.

Before contacting Meta, the worker atomically reserves a pending campaign recipient by marking it failed with SEND_OUTCOME_UNCONFIRMED. Only the worker that wins this conditional update may send. Confirmed success changes it to sent. Provider rejection records failure without retry, including rate limits. A crash or database failure after reservation leaves the recipient failed/unconfirmed; it is deliberately not resent even if this means an unsent message must be reviewed. The legacy inline sender uses the same reservation.

Normal scheduling, queue-slot waits and pacing of never-attempted recipients continue. They do not repeat a Meta send. Existing pending recipients deferred by the older policy can still receive their first attempt under the new policy; previously completed attempts cannot be reconstructed from missing history.

Deploy API and all campaign workers together, stopping old workers first. No database migration is required. Already running old code cannot be changed retroactively, and in-flight requests cannot be recalled. Creating a separate campaign can intentionally send to the same contact again; this guard applies to a campaign recipient row, not every future campaign.

Recipient rejection or failure to persist an outcome after reservation does not abort the campaign. The worker retains the durable failed/unconfirmed reservation, logs any persistence failure and continues to other recipients. Failures before safe reservation, campaign-wide database outages or lock loss can still stop execution; they cannot safely be treated as a confirmed recipient failure.

A regression test runs the entire worker through 50 rejected recipients across multiple batches and verifies campaign completion. Completed means processing finished, not that Meta delivered every message. Existing campaigns incorrectly marked failed by the old missing-job check must be started after deployment to process their remaining pending recipients. Failed/unconfirmed recipient rows are never reset.
