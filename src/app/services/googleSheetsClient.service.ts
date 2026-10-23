import axios from 'axios';
import { configuration, fail, googleFileScope } from '../utils/googleSheets';

export class GoogleSheetsClient {
  private async request(method: 'get' | 'post' | 'put', url: string, options: any) {
    try {
      const response = await axios.request({
        method,
        url,
        timeout: 20000,
        maxRedirects: 0,
        maxContentLength: 6 * 1024 * 1024,
        maxBodyLength: 6 * 1024 * 1024,
        ...options,
      });
      return response.data;
    } catch (e: any) {
      // Never forward Axios errors: they include authorization headers and client secrets.
      const status = e?.response?.status;
      if (status === 429) fail(429, 'Google Sheets request quota exceeded. Wait and try again.');
      if (status === 401 || e?.response?.data?.error === 'invalid_grant')
        fail(401, 'Google connection expired or was revoked. Reconnect Google.');
      if (status === 403)
        fail(403, 'Google denied access. Enable the APIs and select the spreadsheet through Google Picker.');
      if (status === 404) fail(404, 'Spreadsheet not found or not shared with this application.');
      fail(502, 'Google request failed. Check the connection and try again.');
    }
  }
  async exchange(code: string, verifier: string) {
    const c = configuration();
    const result = await this.request('post', 'https://oauth2.googleapis.com/token', {
      data: new URLSearchParams({
        client_id: c.clientId,
        client_secret: c.clientSecret,
        redirect_uri: c.redirectUri,
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
      }).toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    if (
      !String(result.scope || '')
        .split(' ')
        .includes(googleFileScope)
    )
      fail(403, 'Google Drive file permission was not granted. Reconnect and allow file access.');
    if (!result.refresh_token) fail(400, 'Google did not provide offline access. Reconnect and approve consent.');
    return result;
  }
  async refresh(token: string) {
    const c = configuration();
    return this.request('post', 'https://oauth2.googleapis.com/token', {
      data: new URLSearchParams({
        client_id: c.clientId,
        client_secret: c.clientSecret,
        grant_type: 'refresh_token',
        refresh_token: token,
      }).toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
  }
  async revoke(token: string) {
    await this.request('post', 'https://oauth2.googleapis.com/revoke', {
      data: new URLSearchParams({ token }).toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
  }
  async get(path: string, token: string, params: Record<string, unknown> = {}) {
    return this.request('get', `https://www.googleapis.com/${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      params,
    });
  }
  async metadata(id: string, token: string) {
    return this.request('get', `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${token}` },
      params: { fields: 'spreadsheetId,properties(title),sheets(properties(sheetId,title,gridProperties))' },
    });
  }
  async automation(key: string, input: Record<string, any>, token: string) {
    const headers = { Authorization: `Bearer ${token}` };
    if (key === 'createSpreadsheet') {
      if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 255) fail(400, 'Spreadsheet title must contain 1-255 characters');
      if (input.sheet_title !== undefined && (typeof input.sheet_title !== 'string' || !input.sheet_title.trim() || input.sheet_title.length > 100 || /[:\\/?*\[\]]/.test(input.sheet_title))) fail(400, 'Invalid spreadsheet tab title');
      return this.request('post', 'https://sheets.googleapis.com/v4/spreadsheets', { headers,
        params: { fields: 'spreadsheetId,spreadsheetUrl,properties(title),sheets(properties(sheetId,title))' },
        data: { properties: { title: input.title.trim() }, ...(input.sheet_title ? { sheets: [{ properties: { title: input.sheet_title } }] } : {}) },
      });
    }
    if (!['getRows', 'appendRows', 'updateRows'].includes(key)) fail(400, 'Unsupported Google Sheets flow action');
    if (typeof input.spreadsheet_id !== 'string' || !/^[A-Za-z0-9_-]{10,200}$/.test(input.spreadsheet_id)) fail(400, 'Use a valid spreadsheet_id, not a URL');
    const range = input.range;
    if (typeof range !== 'string' || range.length > 512 || /[\x00-\x1f]/.test(range)) fail(400, 'Use a bounded A1 range including the tab title');
    const match = /^(?:'(?:[^']|'')+'|[^'!\r\n]+)!\$?([A-Z]{1,3})\$?([1-9][0-9]{0,6})(?::\$?([A-Z]{1,3})(?:\$?([1-9][0-9]{0,6}))?)?$/.exec(range);
    const column = (v: string) => v.split('').reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
    if (!match || (match[3] && !match[4] && key !== 'appendRows') || (match[3] && (column(match[3]) < column(match[1]) || column(match[3]) - column(match[1]) >= 100)) || (match[4] && (Number(match[4]) < Number(match[2]) || Number(match[4]) - Number(match[2]) >= 1000))) fail(400, 'Use a range of at most 1,000 rows and 100 columns; open end rows are allowed only for append');
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(input.spreadsheet_id)}/values/${encodeURIComponent(range)}`;
    if (key === 'getRows') return this.request('get', url, { headers, params: { valueRenderOption: 'UNFORMATTED_VALUE', majorDimension: 'ROWS' } });
    return this.request(key === 'appendRows' ? 'post' : 'put', key === 'appendRows' ? `${url}:append` : url, {
      headers, params: { valueInputOption: 'RAW', ...(key === 'appendRows' ? { insertDataOption: 'INSERT_ROWS' } : {}) },
      data: { range, majorDimension: 'ROWS', values: input.values },
    });
  }
  async rows(id: string, title: string, token: string, sample = false) {
    const range = `'${title.replace(/'/g, "''")}'!A1:CV${sample ? 21 : 10002}`;
    const result = await this.request(
      'get',
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}/values/${encodeURIComponent(range)}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        params: {
          valueRenderOption: 'UNFORMATTED_VALUE',
          dateTimeRenderOption: 'FORMATTED_STRING',
          majorDimension: 'ROWS',
        },
      },
    );
    if ((result.values?.length || 0) > 10001)
      fail(413, 'This import supports at most 10,000 rows. Split the tab before importing.');
    return result.values || [];
  }
}
export default new GoogleSheetsClient();
