export function isConnectionAcquireError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let candidate: any = error;
  for (let depth = 0; candidate && depth < 8 && !seen.has(candidate); depth++) {
    seen.add(candidate);
    if (candidate.code === '53300' ||
      /unable to acquire a connection|timeout acquiring a connection|too many clients already|remaining connection slots are reserved/i.test(String(candidate.message || ''))) return true;
    candidate = candidate.cause;
  }
  return false;
}
