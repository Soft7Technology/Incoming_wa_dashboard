// Logs contain message content, but never credentials or complete signed URLs.
const secretKey = /authorization|cookie|password|passwd|secret|token|api.?key|signature|credential/i;
const MAX_BYTES = 64 * 1024;

function cleanString(value: string): string {
  return value
    .replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [REDACTED]')
    .replace(/\bs7_[a-f0-9]{64}\b/gi, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED]')
    .replace(/https?:\/\/[^\s"'<>]+/gi, raw => {
      try {
        const url = new URL(raw);
        url.username = ''; url.password = ''; url.hash = '';
        // Signed media links and invite URLs may carry arbitrary credential names.
        if (url.search) url.search = '?redacted';
        return url.toString();
      } catch { return '[REDACTED URL]'; }
    });
}

export function apiLogBody(value: unknown): any {
  let remaining = MAX_BYTES;
  const seen = new WeakSet<object>();
  function visit(item: any, depth: number): any {
    if (remaining <= 0 || depth > 20) return '[TRUNCATED]';
    if (item === null || item === undefined) return null;
    if (typeof item === 'string') {
      const text = cleanString(item);
      const bytes = Buffer.byteLength(text);
      remaining -= bytes;
      return bytes > MAX_BYTES || remaining < 0 ? '[TRUNCATED STRING]' : text;
    }
    if (typeof item === 'number' || typeof item === 'boolean') { remaining -= 16; return item; }
    if (typeof item !== 'object' || Buffer.isBuffer(item)) return '[OMITTED]';
    if (seen.has(item)) return '[CIRCULAR]';
    seen.add(item);
    if (Array.isArray(item)) {
      const output = [];
      for (const child of item) {
        if (remaining <= 0) { output.push('[TRUNCATED]'); break; }
        remaining -= 4;
        output.push(visit(child, depth + 1));
      }
      return output;
    }
    const output: Record<string, any> = Object.create(null);
    for (const [key, child] of Object.entries(item)) {
      remaining -= Buffer.byteLength(key) + 8;
      if (remaining <= 0) { output._truncated = true; break; }
      output[key] = secretKey.test(key) ? '[REDACTED]' : visit(child, depth + 1);
    }
    return output;
  }
  return visit(value, 0);
}
