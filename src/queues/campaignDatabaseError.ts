export function isConnectionAcquireError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let candidate: any = error;
  for (let depth = 0; candidate && depth < 8 && !seen.has(candidate); depth++) {
    seen.add(candidate);
    // Bounded database waits are transient too; durable recipient claims prevent replay.
    if (['53300', '57014', '55P03', '25P03'].includes(candidate.code) ||
      /unable to acquire a connection|timeout acquiring a connection|too many clients already|remaining connection slots are reserved/i.test(String(candidate.message || ''))) return true;
    candidate = candidate.cause;
  }
  return false;
}
