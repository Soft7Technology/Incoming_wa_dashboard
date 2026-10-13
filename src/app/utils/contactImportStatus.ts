interface QueueStatus {
  state: string;
  attemptsMade: number;
  maxAttempts: number;
}

// Builds the public status from durable counters and, when available, current queue state.
export function contactImportStatus(job: any, queue: QueueStatus | null, now = Date.now()) {
  const pending = queue && ['waiting', 'delayed', 'paused', 'prioritized', 'waiting-children'].includes(queue.state);
  const status = pending && !['completed', 'cancelled'].includes(job.status) ? 'queued'
    : queue?.state === 'active' && !['completed', 'cancelled'].includes(job.status) ? 'processing' : job.status;
  const retryPending = Boolean(pending && (job.status === 'failed' || (queue?.attemptsMade ?? 0) > 0));
  const metadata = job.import_options?.progress || {};
  const statistics = job.import_options?.statistics || {};
  const count = (field: string): number | null => {
    const value = statistics[field] ?? job.result?.[field];
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
  };
  const stage = status === 'queued' ? retryPending ? 'retrying' : 'queued'
    : status === 'processing' ? (job.status !== 'processing' ? 'preparing'
      : ['preparing', 'importing', 'saving'].includes(metadata.stage) ? metadata.stage : 'importing') : status;
  const total = Math.max(0, Number(job.total_rows) || 0);
  const processed = Math.max(0, Math.min(total, Number(job.processed_rows) || 0));
  const progress = status === 'completed' ? 100 : stage === 'preparing' ? 0 : Math.min(99, Math.max(0, Number(job.progress_percentage) || 0));
  const timestamp = (value: any): number | null => {
    if (value === null || value === undefined) return null;
    const result = new Date(value).getTime();
    return Number.isFinite(result) ? result : null;
  };
  const end = status === 'completed' ? timestamp(job.completed_at) : status === 'failed' ? timestamp(job.failed_at) : now;
  const seconds = (start: number | null) => start !== null && end !== null ? Math.max(0, Math.floor((end - start) / 1000)) : null;
  const started = Number(metadata.processing_started_at);
  const updated = Number(metadata.updated_at);
  const duration = now - started;
  const rows = Number(metadata.rows_processed);
  const rowsTotal = Number(metadata.rows_total);
  const fresh = updated <= now && now - updated < 10000;
  const remaining = status === 'processing' && stage === 'importing' && fresh && duration >= 1000 && rows > 0 && rows < rowsTotal
    ? Math.ceil((rowsTotal - rows) / (rows / (duration / 1000))) : null;
  return {
    job_id: job.id, status, database_status: job.status, stage, progress, progress_percentage: progress,
    remaining_rows: Math.max(0, total - processed),
    valid_count: count('valid_count'), invalid_count: count('invalid_count'),
    needs_country_count: count('needs_country_count'), importable_count: count('importable_count'),
    duplicate_count: count('duplicate_count'), unique_count: count('unique_count'),
    created_count: count('created_count'), updated_count: count('updated_count'),
    elapsed_seconds: seconds(timestamp(job.created_at)),
    processing_elapsed_seconds: status === 'queued' ? null : seconds(timestamp(job.started_at)),
    estimated_remaining_seconds: status === 'completed' ? 0 : remaining,
    retry_pending: retryPending, attempts_made: queue?.attemptsMade ?? null, max_attempts: queue?.maxAttempts ?? null,
    status_url: `/v1/admin/contacts/import/${job.id}/status`,
    ...(!['completed', 'failed', 'cancelled'].includes(status) ? { poll_after_ms: 2000 } : {}),
  };
}
