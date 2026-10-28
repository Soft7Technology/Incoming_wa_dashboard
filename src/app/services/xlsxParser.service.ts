import { resolveImportColumn } from '../utils/importColumn';
import { parseStoredContactPhone } from '../utils/importPhone';
import { buildContactImportSummary, detectImportPhoneColumn } from '../utils/contactImportSummary';
import * as XLSX from 'xlsx';
import * as fs from 'fs';
// import { COUNTRY_PHONE_LENGTHS } from '../utils';

interface ParsedContact {
  phone_number: string;
  name?: string;
  email?: string;
  country_code?: string | null;
  is_valid?: boolean;
  attributes: Record<string, any>;
}

interface ParseResult {
  headers: string[];
  selected_phone_column: string;
  contacts: ParsedContact[];
  valid: number;
  invalid: number;
  needs_country: number;
  errors: Array<{ row: number; error: string; status: 'invalid' | 'needs_country'; phone_number?: unknown }>;
}

export interface ImportPreviewOptions {
  phone_column?: string;
  name_column?: string;
  email_column?: string;
  country_code?: string;
}

class XLSXParserService {
  private readWorkbook(filePath: string) {
    // Bound expanded worksheet allocation as well as the existing upload byte limit.
    const maxRows = 100000;
    const workbook = XLSX.readFile(filePath, { codepage: 65001, sheets: 0, sheetRows: maxRows + 2 });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const reference = sheet?.['!fullref'] || sheet?.['!ref'];
    if (reference) {
      const range = XLSX.utils.decode_range(reference);
      if (range.e.r > maxRows) throw new Error(`Import files support at most ${maxRows} data rows. Split this file into smaller files.`);
      if (range.e.c >= 200) throw new Error('Import files support at most 200 columns. Remove unused columns.');
    }
    return workbook;
  }
  /**
   * Parse XLSX file and extract contacts
   * @param filePath Path to XLSX file
   * @param phoneColumn Name of column containing phone numbers (default: 'phone' or 'phone_number')
   * @param nameColumn Name of column containing names (optional)
   * @param emailColumn Name of column containing emails (optional)
   * @param country_codeColumn Name of column containing emails (optional)
   */
  async parseContactsFromFile(
    filePath: string,
    country_code: string = '',
    phoneColumn?: string,
    nameColumn?: string,
    emailColumn?: string,
  ): Promise<ParseResult> {
    try {
      // Read file
      const workbook = this.readWorkbook(filePath);
      const sheetName = workbook.SheetNames[0]; // Use first sheet
      const worksheet = workbook.Sheets[sheetName];

      // Read underlying numeric values, not rounded scientific-notation display text.
      const rawData: any[] = XLSX.utils.sheet_to_json(worksheet, { defval: '', raw: true });

      if (rawData.length === 0) {
        throw new Error('XLSX file is empty');
      }

      // Get headers
      const headers = Object.keys(rawData[0]);

      phoneColumn = resolveImportColumn(headers, phoneColumn);
      nameColumn = resolveImportColumn(headers, nameColumn);
      emailColumn = resolveImportColumn(headers, emailColumn);

      // Auto-detect phone column if not provided
      if (!phoneColumn) {
        phoneColumn = this.detectPhoneColumn(headers) || undefined;
      }

      if (!phoneColumn) {
        throw new Error('Could not detect phone number column. Please specify phoneColumn parameter.');
      }

      const contacts: ParsedContact[] = [];
      const errors: Array<{ row: number; error: string; status: 'invalid' | 'needs_country'; phone_number?: unknown }> = [];
      let validCount = 0;
      let invalidCount = 0;
      let needsCountryCount = 0;

      const codeColumn = headers.find(header =>
        ['countrycode', 'callingcode', 'dialcode', 'country'].includes(header.trim().toLowerCase().replace(/[\s_-]/g, '')),
      );

      // Process each row
      rawData.forEach((row, index) => {
        try {
          const rowCode = codeColumn ? String(row[codeColumn] ?? '').trim() : '';
          const parsedPhone = parseStoredContactPhone(row[phoneColumn!], rowCode || country_code || '');

          // Build contact object
          const contact: ParsedContact = {
            ...parsedPhone,
            attributes: {},
          };

          // Extract name if column specified
          if (nameColumn && row[nameColumn]) {
            contact.name = String(row[nameColumn]).trim();
          }

          // Extract email if column specified
          if (emailColumn && row[emailColumn]) {
            contact.email = String(row[emailColumn]).trim();
          }

          // Store all other columns as attributes
          headers.forEach((header) => {
            if (header !== phoneColumn && header !== nameColumn && header !== emailColumn) {
              const value = row[header];
              if (value !== null && value !== undefined && value !== '') {
                contact.attributes[header] = value;
              }
            }
          });

          contacts.push(contact);
          if (parsedPhone.country_code) validCount++;
          else needsCountryCount++;
        } catch (error: any) {
          const status = error.code === 'NEEDS_COUNTRY' ? 'needs_country' : 'invalid';
          if (status === 'needs_country') needsCountryCount++;
          else invalidCount++;
          errors.push({ row: index + 2, status, error: error.message, phone_number: row[phoneColumn!] });
        }
      });

      return {
        headers,
        selected_phone_column: phoneColumn,
        contacts,
        valid: validCount,
        invalid: invalidCount,
        needs_country: needsCountryCount,
        errors,
      };
    } catch (error: any) {
      throw new Error(`Failed to parse XLSX file: ${error.message}`);
    }
  }

  /**
   * Detect phone number column from headers
   */
  private detectPhoneColumn(headers: string[]): string | null {
    return detectImportPhoneColumn(headers);
  }

  /** Validate the entire file with the worker's parser while retaining the raw sample. */
  async getValidatedPreview(filePath: string, options: ImportPreviewOptions = {},
    assess?: (parsed: ParseResult) => Promise<Record<string, any>>) {
    for (const key of ['phone_column', 'name_column', 'email_column', 'country_code'] as const) {
      if (options[key] !== undefined && typeof options[key] !== 'string') {
        throw new Error(`${key} must be a string`);
      }
    }
    const preview = await this.getFilePreview(filePath);
    const parsed = await this.parseContactsFromFile(
      filePath, options.country_code || '', options.phone_column, options.name_column, options.email_column,
    );
    return {
      ...preview,
      ...buildContactImportSummary(parsed),
      needs_country: parsed.contacts.filter(contact => !contact.country_code),
      normalized_preview: parsed.contacts.slice(0, 5),
      errors: parsed.errors,
      ...(assess ? { subscription: await assess(parsed) } : {}),
    };
  }

  async getFilePreview(filePath: string, rows: number = 5): Promise<any> {
    try {
      console.log(`Generating preview for file: ${filePath}`);
      const workbook = this.readWorkbook(filePath);
      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];

      const rawData: any[] = XLSX.utils.sheet_to_json(worksheet, { defval: '', raw: true });
      console.log(`Total rows in file: ${rawData.length}`);

      return {
        headers: rawData.length > 0 ? Object.keys(rawData[0]) : [],
        preview: rawData.slice(0, rows),
        total_rows: rawData.length,
        detected_phone_column: rawData.length > 0 ? this.detectPhoneColumn(Object.keys(rawData[0])) : null,
      };
    } catch (error: any) {
      throw new Error(`Failed to preview XLSX file: ${error.message}`);
    }
  }

  /**
   * Validate XLSX file structure
   */
  async validateFile(filePath: string): Promise<{ valid: boolean; errors: string[] }> {
    const errors: string[] = [];

    try {
      if (!fs.existsSync(filePath)) {
        errors.push('File does not exist');
        return { valid: false, errors };
      }

      const workbook = this.readWorkbook(filePath);

      if (workbook.SheetNames.length === 0) {
        errors.push('No sheets found in XLSX file');
        return { valid: false, errors };
      }

      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];
      const rawData: any[] = XLSX.utils.sheet_to_json(worksheet);

      if (rawData.length === 0) {
        errors.push('XLSX file is empty');
        return { valid: false, errors };
      }

      const headers = Object.keys(rawData[0]);
      const phoneColumn = this.detectPhoneColumn(headers);

      if (!phoneColumn) {
        errors.push('Could not detect phone number column. Please include a column named "phone", "phone_number", "mobile", or similar.');
      }

      return {
        valid: errors.length === 0,
        errors,
      };
    } catch (error: any) {
      errors.push(`Invalid XLSX file: ${error.message}`);
      return { valid: false, errors };
    }
  }
}

export default new XLSXParserService();
