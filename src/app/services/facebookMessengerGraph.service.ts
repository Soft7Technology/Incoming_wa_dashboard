import axios from 'axios';
import { createHmac } from 'crypto';
import { CustomError } from '@surefy/exceptions/CustomError';
import { decrypt, graphFailure } from '../utils/facebook';

export class MessengerSendError extends CustomError {
  constructor(message: string, status: number, public readonly uncertain: boolean) {
    super(message, status);
    Object.setPrototypeOf(this, MessengerSendError.prototype);
  }
}

class FacebookMessengerGraphService {
  private credentials(ciphertext: string) {
    const secret = process.env.FACEBOOK_MESSENGER_APP_SECRET;
    const version = process.env.FACEBOOK_GRAPH_VERSION;
    if (!secret || !/^v\d+\.\d+$/.test(version || '')) {
      throw new CustomError('Messenger API configuration is incomplete.', 503);
    }
    const token = decrypt(ciphertext);
    return {
      version,
      headers: { Authorization: `Bearer ${token}` },
      params: { appsecret_proof: createHmac('sha256', secret).update(token).digest('hex') },
    };
  }

  async sendText(pageId: string, psid: string, ciphertext: string, text: string): Promise<string> {
    let credentials;
    try {
      if (![pageId, psid].every(id => /^\d{1,80}$/.test(id))) {
        throw new Error('Invalid identifiers');
      }
      credentials = this.credentials(ciphertext);
    } catch {
      throw new MessengerSendError('Messenger credentials are unavailable. Reconnect the Page.', 503, false);
    }
    try {
      const response = await axios.post(
        `https://graph.facebook.com/${credentials.version}/${pageId}/messages`,
        { recipient: { id: psid }, messaging_type: 'RESPONSE', message: { text } },
        {
          headers: credentials.headers, params: credentials.params,
          timeout: 15000, maxRedirects: 0, maxContentLength: 1024 * 1024,
        },
      );
      if (response.data?.error) {
        const safe = graphFailure(Number(response.data.error.code));
        throw new MessengerSendError(safe.message, safe.status, false);
      }
      if (typeof response.data?.message_id !== 'string' || !response.data.message_id ||
          response.data.message_id.length > 255 || String(response.data.recipient_id) !== psid) {
        throw new MessengerSendError('Meta returned an unconfirmed send result. Check the Page inbox before sending again.', 502, true);
      }
      return response.data.message_id;
    } catch (error) {
      if (error instanceof MessengerSendError) throw error;
      if (axios.isAxiosError(error) && error.response && error.response.status < 500 && error.response.data?.error) {
        const safe = graphFailure(Number(error.response.data.error.code));
        throw new MessengerSendError(safe.message, safe.status, false);
      }
      // A network timeout can happen after Meta accepted the message.
      throw new MessengerSendError('Delivery could not be confirmed. Check the Page inbox before sending again.', 502, true);
    }
  }

  async getName(psid: string, ciphertext: string): Promise<string | null> {
    if (!/^\d{1,80}$/.test(psid)) return null;
    const credentials = this.credentials(ciphertext);
    const response = await axios.get(`https://graph.facebook.com/${credentials.version}/${psid}`, {
      headers: credentials.headers,
      params: { ...credentials.params, fields: 'id,first_name,last_name' },
      timeout: 3000, maxRedirects: 0, maxContentLength: 128 * 1024,
    });
    if (response.data?.error || String(response.data?.id) !== psid) return null;
    const name = [response.data.first_name, response.data.last_name]
      .filter(value => typeof value === 'string').join(' ').trim();
    return name ? Array.from(name).slice(0, 255).join('') : null;
  }
}

export default new FacebookMessengerGraphService();
