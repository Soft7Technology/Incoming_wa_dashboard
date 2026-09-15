import * as XLSX from 'xlsx';
import * as fs from 'fs';
// import { COUNTRY_PHONE_LENGTHS } from '../utils';

interface ParsedContact {
  phone_number: string;
  name?: string;
  email?: string;
  country_code?: string;
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
   * @param country_codeColumn Name of column containing emails (optional)
   */
  async parseContactsFromFile(
    filePath: string,
    country_code: string,
    phoneColumn?: string,
    nameColumn?: string,
    emailColumn?: string,
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
          const phoneNumber = this.normalizePhoneNumber(row[phoneColumn!], country_code);

          if (!phoneNumber) {
            invalidCount++;
            errors.push({ row: index + 2, error: 'Missing or invalid phone number' });
            return;
          }

          // Validate phone number format
          if (!this.validatePhoneByCountry(phoneNumber, country_code)) {
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
  private normalizePhoneNumber(
    phone: any,
    country_code: string
  ): string | null {
    console.log("Phone", phone, country_code);

    if (!phone || !country_code) return null;

    let normalized = String(phone)
      .trim()
      .replace(/[^\d+]/g, '');

    // Already in international format
    if (normalized.startsWith('+')) {
      return normalized;
    }

    // Remove leading zeros
    normalized = normalized.replace(/^0+/, '');

    const cleanCountryCode = country_code.replace('+', '');

    // Check if number already starts with country code
    if (!normalized.startsWith(cleanCountryCode)) {
      normalized = `${cleanCountryCode}${normalized}`;
    }

    // Ensure + prefix
    return `+${normalized}`;
  }

  private validatePhoneByCountry(
    phoneNumber: string,
    countryCode: string
  ): any {
    const cleanCountryCode = countryCode.replace('+', '')

    const expectedLength = this.COUNTRY_PHONE_LENGTHS[cleanCountryCode]

    if (!expectedLength) {
      return true; // Skip validation if country not configured
    }

    const nationalNumber = phoneNumber.replace('+', '').slice(cleanCountryCode.length)

    return /^\d+$/.test(nationalNumber) &&
      nationalNumber.length === expectedLength;
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


  private COUNTRY_PHONE_LENGTHS: any = {
    // Asia
    '91': 10, // India
    '92': 10, // Pakistan
    '93': 9, // Afghanistan
    '94': 9, // Sri Lanka
    '95': 8, // Myanmar
    '60': 9, // Malaysia
    '62': 10, // Indonesia
    '63': 10, // Philippines
    '65': 8, // Singapore
    '66': 9, // Thailand
    '81': 10, // Japan
    '82': 10, // South Korea
    '84': 9, // Vietnam
    '86': 11, // China
    '852': 8, // Hong Kong
    '853': 8, // Macau
    '886': 9, // Taiwan

    // Middle East
    '971': 9, // UAE
    '966': 9, // Saudi Arabia
    '965': 8, // Kuwait
    '974': 8, // Qatar
    '973': 8, // Bahrain
    '968': 8, // Oman
    '962': 9, // Jordan
    '961': 8, // Lebanon
    '972': 9, // Israel
    '964': 10, // Iraq
    '98': 10, // Iran

    // North America
    '1': 10, // USA/Canada

    // Europe
    '44': 10, // UK
    '33': 9, // France
    '49': 10, // Germany
    '39': 10, // Italy
    '34': 9, // Spain
    '31': 9, // Netherlands
    '32': 9, // Belgium
    '41': 9, // Switzerland
    '43': 10, // Austria
    '45': 8, // Denmark
    '46': 9, // Sweden
    '47': 8, // Norway
    '48': 9, // Poland
    '351': 9, // Portugal
    '30': 10, // Greece
    '353': 9, // Ireland
    '420': 9, // Czech Republic
    '36': 9, // Hungary
    '40': 9, // Romania
    '380': 9, // Ukraine
    '7': 10, // Russia/Kazakhstan

    // Oceania
    '61': 9, // Australia
    '64': 9, // New Zealand

    // Africa
    '20': 10, // Egypt
    '27': 9, // South Africa
    '234': 10, // Nigeria
    '254': 9, // Kenya
    '255': 9, // Tanzania
    '233': 9, // Ghana
    '251': 9, // Ethiopia
    '212': 9, // Morocco

    // South America
    '55': 11, // Brazil
    '54': 10, // Argentina
    '56': 9, // Chile
    '57': 10, // Colombia
    '51': 9, // Peru
    '58': 10, // Venezuela,
  };

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
