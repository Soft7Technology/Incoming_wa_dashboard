export function resolveImportColumn(headers: string[], requested?: string): string | undefined {
  if (!requested?.trim()) return undefined;
  const normalized = requested.trim().toLowerCase().replace(/[\s_]+/g, ' ');
  const matches = headers.filter(header => header.trim().toLowerCase().replace(/[\s_]+/g, ' ') === normalized);
  if (matches.length !== 1) throw new Error(`Import column "${requested}" ${matches.length ? 'is ambiguous' : 'was not found'}. Available columns: ${headers.join(', ')}`);
  return matches[0];
}
