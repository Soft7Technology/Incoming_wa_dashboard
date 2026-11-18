import HTTP400Error from '@surefy/exceptions/HTTP400Error';

export type ContactImportSource = 'import' | 'facebook';

/** Import provenance is request metadata, never a spreadsheet column. */
export function contactImportSource(value: unknown): ContactImportSource {
  if (value === undefined || value === 'import') return 'import';
  if (value === 'facebook') return 'facebook';
  throw new HTTP400Error({ message: 'source must be import or facebook' });
}
