import * as XLSX from 'xlsx';
import * as fs from 'fs';

interface ParsedContact {
  phone_number: string;
  name?: string;
  email?: string;
  attributes: Record<string, any>;
}

interface ParseResult {
  headers: string[];
  contacts: ParsedContact[];
  valid: number;
  invalid: number;
  errors: Array<{ row: number; error: string }>;
}

class XLSXParserService {
  /**
   * Parse XLSX file and extract contacts
   * @param filePath Path to XLSX file
   * @param phoneColumn Name of column containing phone numbers (default: 'phone' or 'phone_number')
   * @param nameColumn Name of column containing names (optional)
   * @param emailColumn Name of column containing emails (optional)
   */
  async parseContactsFromFile(
    filePath: string,
    phoneColumn?: string,
    nameColumn?: string,
    emailColumn?: string
  ): Promise<ParseResult> {
    try {
      // Read file
      const workbook = XLSX.readFile(filePath);
      const sheetName = workbook.SheetNames[0]; // Use first sheet
      const worksheet = workbook.Sheets[sheetName];

      // Convert to JSON
      const rawData: any[] = XLSX.utils.sheet_to_json(worksheet, { defval: '' });

      if (rawData.length === 0) {
        throw new Error('XLSX file is empty');
      }

      // Get headers
      const headers = Object.keys(rawData[0]);

      // Auto-detect phone column if not provided
      if (!phoneColumn) {
        phoneColumn = this.detectPhoneColumn(headers) || undefined;
      }

      if (!phoneColumn) {
        throw new Error('Could not detect phone number column. Please specify phoneColumn parameter.');
      }

      const contacts: ParsedContact[] = [];
      const errors: Array<{ row: number; error: string }> = [];
      let validCount = 0;
      let invalidCount = 0;

      // Process each row
      rawData.forEach((row, index) => {
        try {
          const phoneNumber = this.normalizePhoneNumber(row[phoneColumn!]);

          if (!phoneNumber) {
            invalidCount++;
            errors.push({ row: index + 2, error: 'Missing or invalid phone number' });
            return;
          }

          // Validate phone number format
          if (!this.isValidPhoneNumber(phoneNumber)) {
            invalidCount++;
            errors.push({ row: index + 2, error: `Invalid phone format: ${phoneNumber}` });
            return;
          }

          // Build contact object
          const contact: ParsedContact = {
            phone_number: phoneNumber,
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
          validCount++;
        } catch (error: any) {
          invalidCount++;
          errors.push({ row: index + 2, error: error.message });
        }
      });

      return {
        headers,
        contacts,
        valid: validCount,
        invalid: invalidCount,
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
    const phonePatterns = [
      'phone',
      'phone_number',
      'phonenumber',
      'mobile',
      'mobile_number',
      'contact',
      'contact_number',
      'whatsapp',
      'whatsapp_number',
      'number',
      'cell',
      'telephone',
    ];

    for (const header of headers) {
      const lowerHeader = header.toLowerCase().replace(/[\s_-]/g, '');
      for (const pattern of phonePatterns) {
        if (lowerHeader.includes(pattern.replace(/[\s_-]/g, ''))) {
          return header;
        }
      }
    }

    return null;
  }

  /**
   * Normalize phone number to international format
   * Removes spaces, dashes, parentheses, and ensures it starts with +
   */
  private normalizePhoneNumber(phone: any): string | null {
    if (!phone) return null;

    // Convert to string and remove all non-numeric characters except +
    let normalized = String(phone)
      .trim()
      .replace(/[\s\-\(\)\.]/g, '');

    // Remove leading zeros
    normalized = normalized.replace(/^0+/, '');

    // Add + if not present
    if (!normalized.startsWith('+')) {
      normalized = '+' + normalized;
    }

    return normalized || null;
  }

  /**
   * Validate phone number format
   * Must be international format (+[country_code][number])
   * Length should be between 10-15 digits
   */
  private isValidPhoneNumber(phone: string): boolean {
    if (!phone) return false;

    // Must start with +
    if (!phone.startsWith('+')) return false;

    // Remove + and check if remaining is all digits
    const digits = phone.substring(1);
    if (!/^\d+$/.test(digits)) return false;

    // Check length (10-15 digits after +)
    if (digits.length < 10 || digits.length > 15) return false;

    return true;
  }

  /**
   * Get preview of XLSX file (first N rows)
   */
  async getFilePreview(filePath: string, rows: number = 5): Promise<any> {
    try {
      console.log(`Generating preview for file: ${filePath}`);
      const workbook = XLSX.readFile(filePath);
      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];

      const rawData: any[] = XLSX.utils.sheet_to_json(worksheet, { defval: '' });
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

      const workbook = XLSX.readFile(filePath);

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
