# Campaign sending policy

Campaigns run through the campaign execution worker only. The unused inline sender and separate campaign_send_attempts model have been removed. The message service makes one Meta request per invocation and never retries a rejected or timed-out request.

The worker atomically changes an existing pending campaign_messages row to failed/unconfirmed before sending. Only the worker that changes this row may send. Success records the message ID; failure remains terminal. This status check is necessary to prevent two workers from sending the same recipient and is not a retry mechanism.

Recipient failures do not stop remaining recipients. Completed means all recipients were processed, not that all messages were delivered. Queue attempts remain one, older jobs are discarded on entry, and stalled-job retries and rebroadcast are disabled. Pacing can delay an unsent recipient; it cannot resend a failed recipient.

Deploy the rebuilt API and all workers together, stopping old processes first. No new migration is required for this change. Migration 20260930000006 is retained for migration-history compatibility; its table is no longer read or written by campaign execution. Existing records are not deleted. Previously failed recipients are never reset when continuing pending recipients.

Focused tests cover simultaneous processing of one recipient, Meta failures, persistence failures, and completion of all 50 recipients when all sends fail. Deployment logs are still needed to identify the process responsible for historical duplicate sends.

The PM2 backend entries resolve cwd from the ecosystem file location. Deploy that file alongside the built backend. The UI keeps its own deployment path. Campaign sends log campaign ID, message ID, process ID and worker mode immediately before the single Meta call. Use these logs to trace extra callers; do not infer the cause from duplicate chat bubbles alone.
