interface ParsedImport {
  headers: string[];
  contacts: Array<{ phone_number: string; country_code?: string | null; name?: string }>;
  valid: number;
  invalid: number;
  needs_country: number;
  selected_phone_column?: string;
}

export function detectImportPhoneColumn(headers: string[]): string | null {
  const patterns = ['phone', 'phone_number', 'phonenumber', 'mobile', 'mobile_number', 'contact',
    'contact_number', 'whatsapp', 'whatsapp_number', 'number', 'cell', 'telephone'];
  for (const header of headers) {
    const normalized = header.toLowerCase().replace(/[\s_-]/g, '');
    if (patterns.some(pattern => normalized.includes(pattern.replace(/[\s_-]/g, '')))) return header;
  }
  return null;
}

// Shared by preview and worker so list summaries describe the same parsed file.
export function buildContactImportSummary(parsed: ParsedImport, selectedColumn?: string) {
  const occurrences = new Map<string, number>();
  for (const contact of parsed.contacts) occurrences.set(contact.phone_number, (occurrences.get(contact.phone_number) || 0) + 1);
  const duplicatePreview: Array<{ phone_number: string; occurrences: number; duplicate_rows: number }> = [];
  for (const [phone, count] of occurrences) {
    if (count > 1) duplicatePreview.push({ phone_number: phone, occurrences: count, duplicate_rows: count - 1 });
    if (duplicatePreview.length === 5) break;
  }
  const detected = detectImportPhoneColumn(parsed.headers);
  const needsCountryPreview = [];
  for (const contact of parsed.contacts) {
    if (!contact.country_code) needsCountryPreview.push({ phone_number: contact.phone_number, name: contact.name ?? null, country_code: null });
    if (needsCountryPreview.length === 5) break;
  }
  return {
    total_rows: parsed.contacts.length + parsed.invalid,
    detected_phone_column: detected,
    selected_phone_column: parsed.selected_phone_column || selectedColumn || detected,
    valid_count: parsed.valid, invalid_count: parsed.invalid, needs_country_count: parsed.needs_country,
    importable_count: parsed.contacts.length,
    duplicate_count: parsed.contacts.length - occurrences.size, unique_count: occurrences.size,
    duplicate_preview: duplicatePreview, needs_country_preview: needsCountryPreview,
  };
}

// Old lists can retain totals while missing file-level data such as duplicate samples.
export function contactListImportSummary(list: any, job?: any) {
  if (job && (job.list_id !== list.id || job.user_id !== list.user_id || job.company_id !== list.company_id ||
      job.phone_number_id !== list.phone_number_id)) job = undefined;
  const statistics = job?.import_options?.statistics || {};
  const result = job?.result || {};
  const count = (...values: any[]): number | null => {
    for (const value of values) if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
    return null;
  };
  const total = count(statistics.total_rows, job?.total_rows, result.total, list.total_contacts);
  const invalid = count(statistics.invalid_count, result.invalid_count, list.invalid_contacts);
  const duplicates = count(statistics.duplicate_count, result.duplicate_count);
  const needsCountry = count(statistics.needs_country_count, result.needs_country_count);
  const preview = (field: string, knownCount: number | null) => {
    const value = statistics[field] ?? result[field];
    return Array.isArray(value) ? value.slice(0, 5) : knownCount === 0 ? [] : null;
  };
  const headers = Array.isArray(list.file_headers) ? list.file_headers.filter((header: unknown) => typeof header === 'string') : [];
  const detected = statistics.detected_phone_column ?? result.detected_phone_column ?? detectImportPhoneColumn(headers);
  const selected = statistics.selected_phone_column ?? result.selected_phone_column ?? job?.import_options?.phone_column ?? detected;
  return {
    total_rows: total, detected_phone_column: detected, selected_phone_column: selected,
    valid_count: count(statistics.valid_count, result.valid_count, list.valid_contacts), invalid_count: invalid,
    importable_count: count(statistics.importable_count, result.importable_count,
      total !== null && invalid !== null ? total - invalid : null),
    duplicate_count: duplicates, unique_count: count(statistics.unique_count, result.unique_count),
    duplicate_preview: preview('duplicate_preview', duplicates),
    needs_country_count: needsCountry, needs_country_preview: preview('needs_country_preview', needsCountry),
    created_count: count(statistics.created_count, result.created_count), updated_count: count(statistics.updated_count, result.updated_count),
    import_job_id: job?.id ?? null,
    import_status_url: job ? `/v1/admin/contacts/import/${job.id}/status` : null,
    statistics_source: job ? 'import_job' : 'legacy_list',
  };
}
