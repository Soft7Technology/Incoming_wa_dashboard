export interface DatabaseFailure { code: string; message: string; }

// Never expose PostgreSQL queries, bindings, detail or connection credentials.
export function getDatabaseFailure(error: unknown): DatabaseFailure | undefined {
  const seen = new Set<unknown>();
  let candidate: any = error;
  for (let depth = 0; candidate && depth < 8 && !seen.has(candidate); depth++) {
    seen.add(candidate);
    const code = String(candidate.code || '');
    if (['57014', '55P03', '25P03'].includes(code)) {
      return { code, message: 'Database operation exceeded its allowed time. Please try again later.' };
    }
    if (['42P01', '42703', '3F000'].includes(code)) {
      return { code, message: 'Required database schema is unavailable. Verify the database connection and migrations.' };
    }
    if (code.startsWith('08') || ['53300', '57P01', '57P02', '57P03', '28P01', '28000', '42501'].includes(code)) {
      return { code, message: 'Database connection or access is unavailable.' };
    }
    if (candidate.name === 'KnexTimeoutError' || /timeout acquiring a connection|unable to acquire a connection/i.test(String(candidate.message || ''))) {
      return { code: 'DB_POOL_TIMEOUT', message: 'Database connection pool is temporarily unavailable.' };
    }
    if (['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENOTFOUND'].includes(code)) {
      return { code, message: 'Background service connection is unavailable.' };
    }
    candidate = candidate.cause;
  }
  return undefined;
}

const reported = new Map<string, number>();
export function reportBackgroundError(component: string, error: unknown, context: Record<string, unknown> = {}): void {
  const failure = getDatabaseFailure(error);
  const key = `${component}:${failure?.code || 'unexpected'}`;
  const now = Date.now();
  const previous = reported.get(key);
  if (previous !== undefined && now - previous < 60000) return;
  if (reported.size >= 128 && !reported.has(key)) reported.delete(reported.keys().next().value!);
  reported.set(key, now);
  console.error(`[${component}]`, {
    ...context,
    ...(failure || { message: error instanceof Error ? error.message : 'Background operation failed' }),
  });
}
