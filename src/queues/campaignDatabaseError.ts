export function isConnectionAcquireError(error: unknown): boolean {
  const candidate = error as { message?: string; code?: string; cause?: unknown } | null;
  const message = String(candidate?.message || error || '');
  return candidate?.code === '53300' ||
    /unable to acquire a connection|timeout acquiring a connection|too many clients already|remaining connection slots are reserved/i.test(message) ||
    (candidate?.cause != null && candidate.cause !== error && isConnectionAcquireError(candidate.cause));
}
