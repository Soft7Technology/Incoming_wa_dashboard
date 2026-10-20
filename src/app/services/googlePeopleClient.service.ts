import axios from 'axios';
import { contactsScope, fail, PeopleOAuthClient, personFields, contactResource } from '../utils/googlePeople';

export class GooglePeopleClient {
  private async request(method: 'get' | 'post' | 'patch', url: string, options: any) {
    try {
      return (
        await axios.request({
          method,
          url,
          timeout: 20000,
          maxRedirects: 0,
          maxContentLength: 2 * 1024 * 1024,
          maxBodyLength: 1024 * 1024,
          ...options,
        })
      ).data;
    } catch (error: any) {
      // Axios errors contain tokens and contact payloads. Never log or forward them.
      const status = error?.response?.status,
        detail = error?.response?.data?.error;
      if (status === 401 || detail === 'invalid_grant')
        fail(401, 'Google Contacts authorization expired or was revoked. Reconnect Google Contacts.');
      if (
        status === 409 ||
        detail?.status === 'FAILED_PRECONDITION' ||
        (Array.isArray(detail?.errors) && detail.errors.some((e: any) => e.reason === 'failedPrecondition'))
      )
        fail(409, 'This Google contact changed. Read it again and reapply your edits.');
      if (status === 400)
        fail(400, 'Google rejected the contact or OAuth request. Check the supported fields and app configuration.');
      if (status === 403)
        fail(403, 'Google denied Contacts access. Enable People API and reconnect with the contacts permission.');
      if (status === 404) fail(404, 'Google contact not found in the connected account.');
      if (status === 429) fail(429, 'Google People API quota exceeded. Wait before trying again.');
      if (url.startsWith('https://people.googleapis.com/') && method !== 'get')
        fail(
          502,
          'Google did not confirm the contact write. Check Google Contacts before retrying to avoid a duplicate.',
        );
      fail(502, 'Google Contacts request failed. Check the connection and try again.');
    }
  }
  async exchange(code: string, verifier: string, client: PeopleOAuthClient) {
    const result = await this.request('post', 'https://oauth2.googleapis.com/token', {
      data: new URLSearchParams({
        client_id: client.clientId,
        client_secret: client.clientSecret,
        redirect_uri: client.redirectUri,
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
      }).toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    if (
      !String(result.scope || '')
        .split(/\s+/)
        .includes(contactsScope)
    )
      fail(403, 'Google Contacts write permission was not granted. Connect again and approve Contacts access.');
    if (typeof result.refresh_token !== 'string' || !result.refresh_token || result.refresh_token.length > 16384)
      fail(400, 'Google did not provide offline access. Connect again and approve consent.');
    return result;
  }
  async refresh(refreshToken: string, client: PeopleOAuthClient) {
    return this.request('post', 'https://oauth2.googleapis.com/token', {
      data: new URLSearchParams({
        client_id: client.clientId,
        client_secret: client.clientSecret,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }).toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
  }
  async list(token: string, pageSize: number, pageToken?: string) {
    return this.request('get', 'https://people.googleapis.com/v1/people/me/connections', {
      headers: { Authorization: `Bearer ${token}` },
      params: {
        personFields,
        sources: 'READ_SOURCE_TYPE_CONTACT',
        sortOrder: 'LAST_MODIFIED_DESCENDING',
        pageSize,
        ...(pageToken ? { pageToken } : {}),
      },
    });
  }
  async get(token: string, resourceName: string) {
    return this.request('get', `https://people.googleapis.com/v1/${contactResource(resourceName)}`, {
      headers: { Authorization: `Bearer ${token}` },
      params: { personFields, sources: 'READ_SOURCE_TYPE_CONTACT' },
    });
  }
  async create(token: string, person: Record<string, any>) {
    return this.request('post', 'https://people.googleapis.com/v1/people:createContact', {
      headers: { Authorization: `Bearer ${token}` },
      params: { personFields },
      data: person,
    });
  }
  async update(token: string, resourceName: string, person: Record<string, any>, fields: string[]) {
    return this.request('patch', `https://people.googleapis.com/v1/${contactResource(resourceName)}:updateContact`, {
      headers: { Authorization: `Bearer ${token}` },
      params: { personFields, updatePersonFields: fields.join(',') },
      data: person,
    });
  }
}
