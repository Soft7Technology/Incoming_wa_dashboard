import axios from 'axios';
import { configuration, fail, googleFileScope } from '../utils/googleSheets';

export class GoogleSheetsClient {
  private async request(method: 'get' | 'post', url: string, options: any) {
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
