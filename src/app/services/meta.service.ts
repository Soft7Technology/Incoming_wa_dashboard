import { campaignRecipientNumber } from '../utils/campaignPhone';
import { parseWhatsAppPhone } from '../utils/importPhone';
import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import HTTP500Error from '@surefy/exceptions/HTTP500Error';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';
import { bucket } from '@surefy/config/firebase.config';
import activityLogsModel from '../models/activityLogs.model';
import wabaCredentials from './wabaCredentials.service';
import crypto from 'crypto';
import https from 'https';
import { metaSendError } from '../utils/metaSendError';
import { WabaOnboardingError, metaTokenAppConfig, secondaryMetaToken } from '../utils/wabaOnboarding';

class MetaService {
  private client: AxiosInstance;
  private apiVersion: string;
  private accessToken: string;
  private onboardingSubscriptionConfirmed = false;
  private readonly authorizationFailures = new WeakSet<object>();
  private agent: https.Agent;

  constructor(private readonly credential?: { token: string; useProof?: boolean }, agent?: https.Agent) {
    this.apiVersion = process.env.META_API_VERSION || 'v18.0';
    this.accessToken = credential?.token || process.env.META_ACCESS_TOKEN || '';
    this.agent = agent || new https.Agent({ family: 4, keepAlive: true });

    this.client = axios.create({
      baseURL: `https://graph.facebook.com/${this.apiVersion}`,
      timeout: 30000,
      // This deployment has no IPv6 route. Avoid Node's short dual-stack attempt
      // deadline abandoning a usable IPv4 connection before the request timeout.
      httpsAgent: this.agent,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.accessToken}`,
      },
    });
    this.client.interceptors?.request.use(async request => {
      if (this.credential) {
        request.headers.set('Authorization', `Bearer ${this.accessToken}`);
        const appSecret = this.credential.useProof ? metaTokenAppConfig(this.accessToken).appSecret : undefined;
        if (appSecret) request.params = { ...(request.params || {}), appsecret_proof: crypto.createHmac('sha256', appSecret).update(this.accessToken).digest('hex') };
        return request;
      }
      const resource = /^\/(\d+)(?:\/|$)/.exec(request.url || '')?.[1];
      if (resource) {
        const token = await wabaCredentials.forResource(resource);
        if (token) {
          request.headers.set('Authorization', `Bearer ${token}`);
          const secret = token === process.env.META_ACCESS_TOKEN ? undefined : metaTokenAppConfig(token).appSecret;
          if (secret) request.params = { ...(request.params || {}), appsecret_proof: crypto.createHmac('sha256', secret).update(token).digest('hex') };
        }
      }
      return request;
    });
    this.client.interceptors?.response?.use(response => response, error => {
      this.rememberAuthorizationFailure(error);
      return Promise.reject(error);
    });
  }

  private isAuthorizationRejection(error: any): boolean {
    const meta = error?.response?.data?.error;
    const code = Number(meta?.code), subcode = Number(meta?.error_subcode);
    return [400, 401, 403].includes(error?.response?.status) && meta?.is_transient !== true &&
      ([190, 102, 10, 200, 294].includes(code) || code === 100 && subcode === 33);
  }

  private rememberAuthorizationFailure(error: any) {
    if (this.isAuthorizationRejection(error)) {
      for (const value of [error, error.response.data, error.response.data.error]) this.authorizationFailures.add(value);
    }
  }

  private wasAuthorizationRejected(error: any): boolean {
    return [error, error?.details, error?.details?.error].some(value =>
      value && typeof value === 'object' && this.authorizationFailures.has(value));
  }

  private preserveRejection<T extends Error>(original: any, wrapped: T): T {
    if (this.wasAuthorizationRejected(original)) this.authorizationFailures.add(wrapped);
    return wrapped;
  }

  private get useServerFallback(): boolean {
    return !this.credential && Boolean(process.env.META_NEW_APP_ACCESS_TOKEN) &&
      process.env.META_NEW_APP_ACCESS_TOKEN !== this.accessToken;
  }

  /** Retry a rejected operation with a fresh body/client, keeping customer credentials pinned. */
  private async withResourceTokenFallback<T>(resource: string | null,
    operation: (client: MetaService, secondary: boolean) => Promise<T>): Promise<T> {
    const savedToken = resource ? await wabaCredentials.forResource(resource) : null;
    return this.withOnboardingTokenFallback(savedToken, operation);
  }

  /**
   * Send a message via WhatsApp Business API
   */
  async sendMessage(phoneNumberId: string, payload: any, allowUnverifiedRecipient = false, redactLogs = false): Promise<any> {
    if (this.useServerFallback) return this.withResourceTokenFallback(phoneNumberId,
      client => client.sendMessage(phoneNumberId, payload, allowUnverifiedRecipient, redactLogs));
    if (allowUnverifiedRecipient && payload.to !== undefined) {
      payload = { ...payload, to: campaignRecipientNumber(payload.to) };
    } else if (payload.to !== undefined) {
      try {
        const identity = parseWhatsAppPhone(payload.to);
        payload = { ...payload, to: identity.country_code + identity.phone_number };
      } catch (error: any) { throw new HTTP400Error({ message: `Invalid international recipient: ${error.message}` }); }
    }
    if (!payload.to) throw new HTTP400Error({ message: 'Recipient is required' });
    const startedAt = Date.now();
    try {
      const response = await this.client.post(`/${phoneNumberId}/messages`, payload);
      return response.data;
    } catch (error: any) {
      const failure = metaSendError(error);
      console.error('Meta API Error - Send Message:', {
        ...failure.diagnostic,
        elapsed_ms: Date.now() - startedAt,
        ...(redactLogs ? {} : { phone_number_id: phoneNumberId }),
      });
      if (redactLogs) {
        throw this.preserveRejection(error, new HTTP500Error({ message: 'WhatsApp message outcome could not be confirmed.' }));
      }
      throw new HTTP500Error({
        message: 'Failed to send message via Meta API',
        details: failure.details,
      });
    }
  }

  /**
   * Mark message as read
   */
  async markAsRead(phoneNumberId: string, messageId: string): Promise<any> {
    if (this.useServerFallback) return this.withResourceTokenFallback(phoneNumberId, client => client.markAsRead(phoneNumberId, messageId));
    try {
      const response = await this.client.post(`/${phoneNumberId}/messages`, {
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId,
      });
      return response.data;
    } catch (error: any) {
      console.error('Meta API Error - Mark as Read:', metaSendError(error).diagnostic);
      throw new HTTP500Error({
        message: 'Failed to mark message as read',
        details: error.response?.data || error.message,
      });
    }
  }

  /**
   * Get all message templates for a WABA
   */
  async getTemplates(wabaId: string): Promise<any> {
    if (this.useServerFallback) return this.withResourceTokenFallback(wabaId, client => client.getTemplates(wabaId));
    try {
      const data: any[] = [];
      let after: string | undefined;
      do {
        const response = await this.client.get(`/${wabaId}/message_templates`, { params: { limit: 100, after } });
        data.push(...(response.data.data || []));
        const next = response.data.paging?.next ? response.data.paging?.cursors?.after : undefined;
        if (next && next === after) throw new Error('Meta returned a repeated pagination cursor');
        after = next;
      } while (after);
      return { data };
    } catch (error: any) {
      console.error('Meta API Error - Get Templates:', metaSendError(error).diagnostic);
      throw new HTTP500Error({
        message: 'Failed to fetch templates from Meta API',
        details: error.response?.data || error.message,
      });
    }
  }

  /**
   * Create a new message template
   */
  async createTemplate(wabaId: string, templateData: any): Promise<any> {
    if (this.useServerFallback) return this.withResourceTokenFallback(wabaId, client => client.createTemplate(wabaId, templateData));
    try {
      const response = await this.client.post(`/${wabaId}/message_templates`, templateData);
      return response.data;
    } catch (error: any) {
      console.error('Meta API Error - Create Template:', metaSendError(error).diagnostic);
      const ErrorType = error.response?.status === 400 ? HTTP400Error : HTTP500Error;
      throw new ErrorType({
        message: 'Failed to create template via Meta API',
        details: error.response?.data || error.message,
      });
    }
  }

  async getTemplate(templateId: string): Promise<any> {
    if (this.useServerFallback) return this.withResourceTokenFallback(templateId, client => client.getTemplate(templateId));
    try {
      const response = await this.client.get(`/${templateId}`, {
        params: { fields: 'id,name,language,category,status,components' },
      });
      return response.data;
    } catch (error: any) {
      throw new HTTP500Error({ message: 'Failed to fetch template from Meta', details: error.response?.data?.error || error.message });
    }
  }

  async updateTemplate(templateId: string, payload: any): Promise<any> {
    if (this.useServerFallback) return this.withResourceTokenFallback(templateId, client => client.updateTemplate(templateId, payload));
    try {
      const response = await this.client.post(`/${templateId}`, payload);
      return response.data;
    } catch (error: any) {
      const ErrorType = error.response?.status === 400 ? HTTP400Error : HTTP500Error;
      throw new ErrorType({ message: 'Meta rejected the template update', details: error.response?.data?.error || error.message });
    }
  }

  /**
   * Delete a message template
   */
  async deleteTemplate(wabaId: string, templateName: string, templateId?: string): Promise<any> {
    if (this.useServerFallback) return this.withResourceTokenFallback(wabaId, client => client.deleteTemplate(wabaId, templateName, templateId));
    try {
      const response = await this.client.delete(`/${wabaId}/message_templates`, {
        params: {
          name: templateName,
          hsm_id: templateId,
        },
      });
      return response.data;
    } catch (error: any) {
      console.error('Meta API Error - Delete Template:', metaSendError(error).diagnostic);
      throw new HTTP500Error({
        message: 'Failed to delete template via Meta API',
        details: error.response?.data || error.message,
      });
    }
  }

  /**
   * Get WABA phone numbers
   */
  async getWabaMessagingLimit(wabaId: string): Promise<any> {
    if (this.useServerFallback) return this.withResourceTokenFallback(wabaId, client => client.getWabaMessagingLimit(wabaId));
    try {
      const response = await this.client.get(`/${wabaId}`, {
        params: { fields: 'id,whatsapp_business_manager_messaging_limit' },
      });
      return response.data;
    } catch (error: any) {
      if (error instanceof WabaOnboardingError) throw error;
      const code = Number(error.response?.data?.error?.code);
      if ([10, 102, 190, 200, 294].includes(code) || code === 100 && Number(error.response?.data?.error?.error_subcode) === 33)
        throw this.preserveRejection(error, new WabaOnboardingError('META_PERMISSION_REQUIRED',
          'Meta denied access to this WABA. Check its authorization and WhatsApp business management permission.', false, 403));
      // Do not return or log Axios request objects, tokens or upstream bodies.
      throw new WabaOnboardingError('WABA_MESSAGING_LIMIT_FETCH_FAILED',
        'Could not fetch the messaging limit from Meta. The last saved limit is unchanged.', true, 502);
    }
  }

  /** Keep existing accounts on their app; new accounts must use the new app. */
  async withAccountToken<T>(savedToken: string | null, newAccount: boolean,
    operation: (client: MetaService, secondary: boolean) => Promise<T>): Promise<T> {
    const token = savedToken || (newAccount ? secondaryMetaToken() : this.accessToken);
    if (!token) throw new WabaOnboardingError('WABA_CREDENTIAL_UNAVAILABLE',
      'The configured WhatsApp account authorization is unavailable.', false, 503);
    const secondary = token === process.env.META_NEW_APP_ACCESS_TOKEN && token !== process.env.META_ACCESS_TOKEN;
    const client = new MetaService({ token, useProof: token !== process.env.META_ACCESS_TOKEN }, this.agent);
    return operation(client, secondary);
  }

  /** One retry after a confirmed Meta authorization rejection; never after uncertain delivery. */
  async withOnboardingTokenFallback<T>(savedToken: string | null,
    operation: (client: MetaService, secondary: boolean) => Promise<T>): Promise<T> {
    const primaryToken = savedToken || this.accessToken;
    // Reuse keep-alive connections while keeping credentials and failure state per operation.
    const primary = new MetaService({ token: primaryToken, useProof: Boolean(savedToken) && primaryToken !== process.env.META_ACCESS_TOKEN }, this.agent);
    try {
      return await operation(primary, Boolean(primaryToken && primaryToken === process.env.META_NEW_APP_ACCESS_TOKEN && primaryToken !== process.env.META_ACCESS_TOKEN));
    } catch (error: any) {
      const authorizationRejected = primary.wasAuthorizationRejected(error);
      // A saved customer credential must never be replaced by a broader server credential.
      // Once subscription succeeds, finish/retry with that app rather than changing webhook owners.
      if (savedToken || primary.onboardingSubscriptionConfirmed || !authorizationRejected ||
          !process.env.META_NEW_APP_ACCESS_TOKEN || process.env.META_NEW_APP_ACCESS_TOKEN === primaryToken) throw error;
      const secondary = new MetaService({ token: secondaryMetaToken(), useProof: true }, this.agent);
      return operation(secondary, true);
    }
  }

  async verifyOnboardingWebhooks(coexistence: boolean) {
    const { appId, appSecret } = metaTokenAppConfig(this.accessToken);
    const callback = process.env.WABA_WEBHOOK_CALLBACK_URL;
    if (!callback || !/^https:\/\//.test(callback)) throw new WabaOnboardingError('WABA_WEBHOOK_CONFIGURATION_REQUIRED',
      'Configure WABA_WEBHOOK_CALLBACK_URL and verify that callback in the secondary Meta app before onboarding with it.', false, 503);
    let subscriptions: any;
    try {
      const response = await axios.get(`https://graph.facebook.com/${this.apiVersion}/${appId}/subscriptions`, {
        headers: { Authorization: `Bearer ${appId}|${appSecret}` }, httpsAgent: this.agent, timeout: 15000, maxRedirects: 0,
      });
      subscriptions = response.data?.data;
    } catch {
      throw new WabaOnboardingError('WABA_WEBHOOK_CONFIGURATION_REQUIRED', 'Could not verify the secondary app webhook configuration.', false, 503);
    }
    const required = ['messages', 'account_update', ...(coexistence ? ['smb_app_state_sync', 'smb_message_echoes', 'history'] : [])];
    const subscription = Array.isArray(subscriptions) && subscriptions.find((row: any) =>
      row.object === 'whatsapp_business_account' && row.active !== false && row.callback_url === callback);
    const fields = new Set((subscription?.fields || []).map((field: any) => typeof field === 'string' ? field : field.name));
    if (!subscription || required.some(field => !fields.has(field))) throw new WabaOnboardingError('WABA_WEBHOOK_CONFIGURATION_REQUIRED',
      `Verify the secondary app callback and subscribe these WhatsApp webhook fields: ${required.join(', ')}.`, false, 409);
  }

  async getPhoneNumbers(wabaId: string): Promise<any> {
    if (this.useServerFallback) return this.withResourceTokenFallback(wabaId, client => client.getPhoneNumbers(wabaId));
    try {
      const data: any[] = [];
      const cursors = new Set<string>();
      let after: string | undefined;
      do {
        const response = await this.client.get(`/${wabaId}/phone_numbers`, {
          params: { fields: 'id,verified_name,display_phone_number,quality_rating,code_verification_status,status,platform_type,is_on_biz_app', limit: 100, after },
        });
        if (!Array.isArray(response.data?.data)) throw new Error('Invalid phone number response from Meta');
        data.push(...response.data.data);
        if (!response.data.paging?.next) break;
        const next = response.data.paging?.cursors?.after;
        if (typeof next !== 'string' || !next || cursors.has(next)) {
          throw new Error('Meta returned an invalid or repeated phone number pagination cursor');
        }
        cursors.add(next);
        after = next;
      } while (after);
      return { data };
    } catch (error: any) {
      console.error('Meta API Error - Get Phone Numbers:', metaSendError(error).diagnostic);
      throw new HTTP500Error({
        message: 'Failed to fetch phone numbers from Meta API',
        details: error.response?.data || error.message,
      });
    }
  }

  /**
   * Get phone number details
   */
  async getPhoneNumberDetails(phoneNumberId: string): Promise<any> {
    if (this.useServerFallback) return this.withResourceTokenFallback(phoneNumberId, client => client.getPhoneNumberDetails(phoneNumberId));
    try {
      const response = await this.client.get(`/${phoneNumberId}`, {
        params: {
          fields: 'id,verified_name,display_phone_number,quality_rating,code_verification_status,whatsapp_business_manager_messaging_limit',
        },
      });
      console.log('Response', response.data);
      return response.data;
    } catch (error: any) {
      console.error('Meta API Error - Get Phone Number Details:', metaSendError(error).diagnostic);
      throw new HTTP500Error({
        message: 'Failed to fetch phone number details from Meta API',
        details: error.response?.data || error.message,
      });
    }
  }

  /**
   * Upload media to Meta
   */
  async uploadMedia(phoneNumberId: string, file: Express.Multer.File, type: string): Promise<any> {
    if (this.useServerFallback) return this.withResourceTokenFallback(phoneNumberId, client => client.uploadMedia(phoneNumberId, file, type));
    try {
      const FormData = require('form-data');
      const fs = require('fs');
      const formData = new FormData();
      formData.append('messaging_product', 'whatsapp');

      // WhatsApp API expects the file as a stream or buffer
      formData.append('file', fs.createReadStream(file.path), {
        filename: file.originalname,
        contentType: file.mimetype,
      });

      const headers = formData.getHeaders();
      headers['Authorization'] = `Bearer ${this.accessToken}`;

      const response = await this.client.post(`/${phoneNumberId}/media`, formData, {
        headers,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      });
      console.log('Response',response.data)
      return response.data;
    } catch (error: any) {
      console.error('Meta API Error - Upload Media:', metaSendError(error).diagnostic);
      throw new HTTP500Error({
        message: 'Failed to upload media to Meta API',
        details: error.response?.data || error.message,
      });
    }
  }

  /**
   * Upload sample media for template creation using Meta's Resumable Upload API.
   * Returns the header handle string (starting with "4::...").
   */
  async uploadTemplateMedia(file: Express.Multer.File, resourceId?: string): Promise<string> {
    if (!this.credential && (this.useServerFallback || resourceId))
      return this.withResourceTokenFallback(resourceId || null, client => client.uploadTemplateMedia(file));
    try {
      const fs = require('fs');
      const fileStats = fs.statSync(file.path);
      const fileLength = fileStats.size;
      const fileType = file.mimetype;

      // 1. Create upload session via Meta App Uploads API
      const sessionRes = await this.client.post(`/app/uploads`, null, {
        params: {
          file_length: fileLength,
          file_type: fileType,
          access_token: this.accessToken,
        },
      });

      const uploadSessionId = sessionRes.data.id;

      // 2. Upload file content to the session
      const fileBuffer = fs.readFileSync(file.path);
      const uploadRes = await axios.post(
        `https://graph.facebook.com/${this.apiVersion}/${uploadSessionId}`,
        fileBuffer,
        {
          headers: {
            Authorization: `OAuth ${this.accessToken}`,
            file_offset: 0,
            'Content-Type': fileType,
          },
          maxContentLength: Infinity,
          maxBodyLength: Infinity,
          httpsAgent: this.agent,
          timeout: 30000,
          maxRedirects: 0,
        },
      );

      return uploadRes.data.h;
    } catch (error: any) {
      this.rememberAuthorizationFailure(error);
      console.error('Meta API Error - Upload Template Media Handle:', metaSendError(error).diagnostic);
      throw error;
    }
  }

  /**
   * Get media URL
   */
  async getMediaUrl(mediaId: string): Promise<any> {
    if (this.useServerFallback) return this.withResourceTokenFallback(mediaId, client => client.getMediaUrl(mediaId));
    try {
      const response = await this.client.get(`/${mediaId}`);
      return response.data;
    } catch (error: any) {
      console.error('Meta API Error - Get Media URL:', metaSendError(error).diagnostic);
      throw new HTTP500Error({
        message: 'Failed to get media URL from Meta API',
        details: error.response?.data || error.message,
      });
    }
  }

  /**
   * Subscribe WABA Id
   */
  async subscribeToWebhooks(
    wabaId: string,
    options?: {
      user_id?: string;
      company_id?: string;
      company_waba_id?: string;
    },
  ): Promise<any> {
    if (this.useServerFallback) return this.withResourceTokenFallback(wabaId, async (client, secondary) => {
      if (secondary) {
        const phones = await client.getPhoneNumbers(wabaId);
        await client.verifyOnboardingWebhooks(phones.data.some((phone: any) => phone.is_on_biz_app === true));
      }
      return client.subscribeToWebhooks(wabaId, options);
    });
    try {
      let response;
      try {
        response = await this.client.post(`/${wabaId}/subscribed_apps`, {});
      } catch (error: any) {
        // Meta can reject a repeated subscription even when Embedded Signup has
        // already subscribed this app. Confirm that exact app with the same token.
        if (error.response?.status !== 403 || error.response?.data?.error?.code !== 200) throw error;
        let subscriptions;
        try { subscriptions = await this.client.get(`/${wabaId}/subscribed_apps`); }
        catch { throw error; }
        const { appId } = metaTokenAppConfig(this.accessToken);
        if (!appId || !Array.isArray(subscriptions.data?.data) ||
            !subscriptions.data.data.some((row: any) => row.whatsapp_business_api_data?.id === appId)) throw error;
        response = { data: { success: true, already_subscribed: true } };
      }

      if (!response.data?.success) {
        throw new Error('Webhook subscription failed');
      }
      this.onboardingSubscriptionConfirmed = true;

      // The Axios response includes request authorization headers; never log it.

      if (options?.user_id && options?.company_id) {
        await activityLogsModel.create({
          company_id: options.company_id,
          user_id: options.user_id,
          action: 'SUBSCRIBE',
          entity_type: 'WEBHOOK',
          entity_id: options.company_waba_id || wabaId,
          description: `Subscribed WABA ${wabaId} to Meta webhooks`,
          new_data: {
            waba_id: wabaId,
            response: response.data,
          },
          status: 'SUCCESS',
          read: false,
        });
      }

      return response.data;
    } catch (error: any) {
      if (options?.user_id && options?.company_id) {
        await activityLogsModel.create({
          company_id: options.company_id,
          user_id: options.user_id,
          action: 'SUBSCRIBE',
          entity_type: 'WEBHOOK',
          entity_id: options.company_waba_id || wabaId,
          description: `Failed to subscribe WABA ${wabaId} to Meta webhooks`,
          new_data: {
            waba_id: wabaId,
            error: error.response?.data || error.message,
          },
          status: 'FAILED',
          read: false,
        });
      }

      console.error('Meta API Error - Failed to subscribe to webhooks', metaSendError(error).diagnostic);

      throw new HTTP500Error({
        message: 'Failed to subscribe WABA to Meta webhooks',
        details: error.response?.data || error.message,
      });
    }
  }

  /**
   * Get WABA account details to verify it exists
   */
  async getWabaDetails(wabaId: string): Promise<any> {
    if (this.useServerFallback) return this.withResourceTokenFallback(wabaId, client => client.getWabaDetails(wabaId));
    try {
      const response = await this.client.get(`/${wabaId}`, {
        params: {
          fields: 'id,name,currency,message_template_namespace,phone_numbers',
        },
      });
      return response.data;
    } catch (error: any) {
      console.error('Meta API Error - Get WABA Details:', metaSendError(error).diagnostic);
      throw new HTTP500Error({
        message: 'Failed to verify WABA account with Meta API. Please check the WABA ID and access token.',
        details: error.response?.data || error.message,
      });
    }
  }

  /**
   * Handle Media,file,document
   */
  async handleMedia(mediaId: string): Promise<any> {
    if (this.useServerFallback) return this.withResourceTokenFallback(mediaId, client => client.handleMedia(mediaId));
    try {
      const mediaRes = await this.client.get(`/${mediaId}`);
      const mediaUrl = mediaRes.data.url;
      const mimeType = mediaRes.data.mime_type;
      console.log('📥 Media URL:', mediaUrl);
      console.log('📄 MIME type:', mimeType);

      // Step 2: Download image
      const downloadRes = await axios.get(mediaUrl, {
        httpsAgent: this.agent,
        timeout: 30000,
        maxRedirects: 0,
        responseType: 'arraybuffer',
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
        },
      });

      const buffer = Buffer.from(downloadRes.data);

      // Step 4: Upload to Firebase Storage
      if (!bucket) throw new Error('Firebase bucket is not initialized');

      // Step 4: Determine extension from MIME type
      const extensionMap: Record<string, string> = {
        // Images
        'image/jpeg': '.jpg',
        'image/jpg': '.jpg',
        'image/png': '.png',
        'image/webp': '.webp',
        'image/gif': '.gif',

        // Videos
        'video/mp4': '.mp4',
        'video/3gpp': '.3gp',
        'video/quicktime': '.mov',
        'video/webm': '.webm',

        // Audio
        'audio/aac': '.aac',
        'audio/mp4': '.m4a',
        'audio/mpeg': '.mp3',
        'audio/amr': '.amr',
        'audio/ogg': '.ogg',
        'audio/opus': '.opus',

        // Documents
        'application/pdf': '.pdf',
        'application/msword': '.doc',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
        'application/vnd.ms-excel': '.xls',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
        'application/vnd.ms-powerpoint': '.ppt',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
        'text/plain': '.txt',
      };
      const extension = extensionMap[mimeType] || '';

      // Step 3: Create filename
      const fileName = `${mediaId}_${Date.now()}${extension}`;

      const file = bucket.file(`whatsapp-media/${fileName}`);

      await file.save(buffer, {
        metadata: {
          contentType: mimeType || 'application/octet-stream',
        },
      });

      // Make file public
      await file.makePublic();

      const firebaseUrl = `https://storage.googleapis.com/${bucket.name}/${file.name}`;

      console.log('✅ Firebase URL:', firebaseUrl);
      return {
        firebaseUrl,
        filename: fileName,
        mime_type: mimeType,
      };
    } catch (error: any) {
      this.rememberAuthorizationFailure(error);
      console.error('Meta API Error - Download Media:', metaSendError(error).diagnostic);
      throw new HTTP400Error({
        message: 'Failed to mark message as read',
        details: error.response?.data || error.message,
      });
    }
  }

  /** Confirm existing connections; only register a verified Cloud-only number. */
  async verifiedPhoneNumbers(phoneNumberId: string): Promise<any> {
    if (this.useServerFallback) return this.withResourceTokenFallback(phoneNumberId, client => client.verifiedPhoneNumbers(phoneNumberId));
    let registrationAccepted = false;
    try {
      const inspect = async () => (await this.client.get(`/${phoneNumberId}`, {
        params: { fields: 'id,status,platform_type,is_on_biz_app,code_verification_status' },
      })).data;
      const phone = await inspect();
      if (phone.is_on_biz_app === true) {
        // Business-app numbers must finish Coexistence in Embedded Signup. Calling
        // /register cannot complete that connection and Meta rejects it for SMBs.
        if (phone.status !== 'CONNECTED' || phone.platform_type !== 'CLOUD_API') {
          throw new WabaOnboardingError('WABA_COEXISTENCE_PENDING',
            'This number is linked to the WhatsApp Business app, but its Cloud API connection is not complete. Finish connecting the existing WhatsApp Business app number through Embedded Signup and approve the connection in the app, then sync and try again.', false, 409);
        }
        return { success: true, already_registered: true, connection_mode: 'coexistence' };
      }
      if (phone.is_on_biz_app !== false || !['CLOUD_API', 'NOT_APPLICABLE'].includes(phone.platform_type)) {
        throw new WabaOnboardingError('WABA_PHONE_MODE_UNCONFIRMED',
          'Meta has not confirmed this is a standard Cloud API number. Complete the appropriate onboarding or migration in WhatsApp Manager before registering it.', false, 409);
      }
      if (phone.status === 'CONNECTED' && phone.platform_type === 'CLOUD_API') {
        return { success: true, already_registered: true, connection_mode: 'cloud_api' };
      }
      if (phone.code_verification_status !== 'VERIFIED') {
        throw new WabaOnboardingError('WABA_PHONE_VERIFICATION_REQUIRED',
          'Complete phone verification in Meta Embedded Signup or WhatsApp Manager before registering this Cloud API number.', false, 409);
      }
      const response = await this.client.post(`/${phoneNumberId}/register`, {
        messaging_product: 'whatsapp',
        pin: '123456',
      });
      registrationAccepted = true;
      const confirmed = await inspect();
      if (confirmed.status !== 'CONNECTED' || confirmed.platform_type !== 'CLOUD_API') {
        throw new WabaOnboardingError('WABA_REGISTRATION_PENDING',
          'Meta has not confirmed the Cloud API connection yet. Sync the account to check its status before trying registration again.', true, 409);
      }
      return response.data;
    } catch (error: any) {
      if (error instanceof WabaOnboardingError) throw error;
      this.rememberAuthorizationFailure(error);
      const failure = metaSendError(error);
      console.error('Meta API Error - Verify Phone Number:', failure.diagnostic);
      if (registrationAccepted) {
        // A read failure after an accepted write must not replay registration
        // with another app's token through the outer authorization fallback.
        throw new WabaOnboardingError('WABA_REGISTRATION_PENDING',
          'Meta accepted registration, but its connection status could not be confirmed. Sync the account to recheck before trying registration again.', true, 409);
      }
      throw this.preserveRejection(error, new HTTP500Error({
        message: 'Failed to verify the WhatsApp phone connection with Meta',
        details: failure.details,
      }));
    }
  }
}

export default new MetaService();
