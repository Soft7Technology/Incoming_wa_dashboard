import fs from 'fs';
const pdf = require('pdf-parse');
import csv from 'csv-parser';
import mammoth from 'mammoth';

export const extractTextFromFile = async (filePath: string, fileType: string): Promise<string> => {
  try {
    const ext = fileType.toLowerCase();

    if (ext === 'txt') {
      return fs.promises.readFile(filePath, 'utf8');
    }

    if (ext === 'pdf') {
      const dataBuffer = await fs.promises.readFile(filePath);
      const data = await pdf(dataBuffer);
      return data.text;
    }

    if (ext === 'doc' || ext === 'docx') {
      const result = await mammoth.extractRawText({ path: filePath });
      return result.value;
    }

    if (ext === 'csv') {
      return new Promise((resolve, reject) => {
        const results: string[] = [];
        fs.createReadStream(filePath)
          .pipe(csv())
          .on('data', (data) => results.push(JSON.stringify(data)))
          .on('end', () => resolve(results.join('\n')))
          .on('error', (err) => reject(err));
      });
    }

    if (ext === 'xls' || ext === 'xlsx') {
      // For simple Excel parsing without installing big libraries, we can just return a placeholder or 
      // if you need actual xlsx parsing, you'd use `xlsx` package. Since xlsx is complex, we will try to use 
      // a simple generic warning if it's not supported by native tools, but we can install xlsx if required.
      // For now, let's just return a placeholder or we can use the `xlsx` module if installed.
      // Assuming we'll add `xlsx` if needed, but the plan was pdf, doc, csv, txt. We included xls/xlsx in the UI.
      try {
        const xlsx = require('xlsx');
        const workbook = xlsx.readFile(filePath);
        let out = '';
        workbook.SheetNames.forEach((sheetName: string) => {
          out += xlsx.utils.sheet_to_csv(workbook.Sheets[sheetName]) + '\n';
        });
        return out;
      } catch (e) {
        return "XLS/XLSX parsing requires the 'xlsx' package.";
      }
    }

    return '';
  } catch (error) {
    console.error(`Error extracting text from ${filePath}:`, error);
    return '';
  }
};
