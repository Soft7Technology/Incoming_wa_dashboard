/** Extract provider errors from our HTTP wrappers, Axios errors, or webhook errors. */
export function getMessageError(error: any): { error_message: string; error_code: string } {
  const provider = error?.details?.error ?? error?.response?.data?.error ?? error;
  const message = provider?.error_data?.details || provider?.message ||
    (typeof error?.details === 'string' ? error.details : undefined) ||
    (typeof error === 'string' ? error : undefined) || 'Unknown error';

  return {
    error_message: String(message),
    error_code: String(provider?.code ?? error?.code ?? 'UNKNOWN'),
  };
}
