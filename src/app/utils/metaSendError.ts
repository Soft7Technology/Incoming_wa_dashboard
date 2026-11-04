/** Keep diagnostics useful without serializing Axios requests, tokens or message bodies. */
export function metaSendError(error: any) {
  const safeCode = (value: unknown): string | undefined =>
    typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value) ? value : undefined;
  const causes: string[] = [];
  for (const child of [error?.cause, ...(Array.isArray(error?.errors) ? error.errors.slice(0, 8) : [])]) {
    const code = safeCode(child?.code);
    if (code && !causes.includes(code)) causes.push(code);
  }
  const code = safeCode(error?.code) || causes[0];
  const provider = error?.response?.data?.error;
  const status = error?.response?.status;
  const trace = provider?.fbtrace_id;
  const diagnostic = {
    network_code: code,
    connection_error_codes: causes,
    upstream_status: Number.isInteger(status) ? status : undefined,
    meta_code: typeof provider?.code === 'number' ? provider.code : undefined,
    meta_subcode: typeof provider?.error_subcode === 'number' ? provider.error_subcode : undefined,
    meta_trace_id: typeof trace === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(trace) ? trace : undefined,
  };

  const networkMessages: Record<string, string> = {
    ETIMEDOUT: 'The connection to WhatsApp timed out.',
    ENETUNREACH: 'The WhatsApp network could not be reached.',
    EHOSTUNREACH: 'The WhatsApp host could not be reached.',
    ECONNREFUSED: 'The connection to WhatsApp was refused.',
    ENOTFOUND: 'The WhatsApp host could not be resolved.',
    EAI_AGAIN: 'The WhatsApp host could not be resolved temporarily.',
    ECONNRESET: 'The connection to WhatsApp was interrupted; delivery is unconfirmed.',
    EPIPE: 'The connection to WhatsApp was interrupted; delivery is unconfirmed.',
    ECONNABORTED: 'The WhatsApp request timed out; delivery is unconfirmed.',
  };
  // Preserve Meta's existing error envelope, including delivery restrictions and billing codes.
  // Network exceptions have no HTTP response; put their code in the same envelope so
  // getMessageError can persist it instead of converting AggregateError to UNKNOWN / Error.
  const details = error?.response?.data || (code && networkMessages[code] ? {
    error: { code, message: networkMessages[code] },
    connection_error_codes: causes,
  } : error?.message || 'Unknown error');
  return { diagnostic, details };
}
