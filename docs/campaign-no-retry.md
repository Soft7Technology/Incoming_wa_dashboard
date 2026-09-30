# Campaign no-retry policy

Campaign job failures are not automatically retried (one attempt, discard on processor entry for older queued jobs, and no stalled-job recovery attempts). Missing execution jobs are marked failed rather than requeued. Failed campaign restart and rebroadcast are rejected.

Before contacting Meta, the worker atomically reserves a pending campaign recipient by marking it failed with SEND_OUTCOME_UNCONFIRMED. Only the worker that wins this conditional update may send. Confirmed success changes it to sent. Provider rejection records failure without retry, including rate limits. A crash or database failure after reservation leaves the recipient failed/unconfirmed; it is deliberately not resent even if this means an unsent message must be reviewed. The legacy inline sender uses the same reservation.

Normal scheduling, queue-slot waits and pacing of never-attempted recipients continue. They do not repeat a Meta send. Existing pending recipients deferred by the older policy can still receive their first attempt under the new policy; previously completed attempts cannot be reconstructed from missing history.

Deploy API and all campaign workers together, stopping old workers first. No database migration is required. Already running old code cannot be changed retroactively, and in-flight requests cannot be recalled. Creating a separate campaign can intentionally send to the same contact again; this guard applies to a campaign recipient row, not every future campaign.
