import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import HTTP500Error from '@surefy/exceptions/HTTP500Error';

class MetaService {
  private client: AxiosInstance;
  private apiVersion: string;
  private accessToken: string;

  constructor() {
    this.apiVersion = process.env.META_API_VERSION || 'v18.0';
    this.accessToken = process.env.META_ACCESS_TOKEN || '';

    this.client = axios.create({
      baseURL: `https://graph.facebook.com/${this.apiVersion}`,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.accessToken}`,
      },
    });
  }

  /**
   * Send a message via WhatsApp Business API
   */
  async sendMessage(phoneNumberId: string, payload: any): Promise<any> {
    try {
      const response = await this.client.post(`/${phoneNumberId}/messages`, payload);
      return response.data;
    } catch (error: any) {
      console.log(`Sending message via Meta API to phone number ID: ${phoneNumberId} with payload: ${JSON.stringify(payload)}`);
      console.error('Meta API Error - Send Message:', error.response?.data || error.message);
      throw new HTTP500Error({
        message: 'Failed to send message via Meta API',
        details: error.response?.data || error.message,
      });
    }
  }

  /**
   * Mark message as read
   */
  async markAsRead(phoneNumberId: string, messageId: string): Promise<any> {
    try {
      const response = await this.client.post(`/${phoneNumberId}/messages`, {
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId,
      });
      return response.data;
    } catch (error: any) {
      console.error('Meta API Error - Mark as Read:', error.response?.data || error.message);
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
    try {
      const response = await this.client.get(`/${wabaId}/message_templates`, {
        params: {
          limit: 100,
        },
      });
      return response.data;
    } catch (error: any) {
      console.error('Meta API Error - Get Templates:', error.response?.data || error.message);
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
    try {
      const response = await this.client.post(`/${wabaId}/message_templates`, templateData);
      return response.data;
    } catch (error: any) {
      console.error('Meta API Error - Create Template:', error.response?.data || error.message);
      throw new HTTP500Error({
        message: 'Failed to create template via Meta API',
        details: error.response?.data || error.message,
      });
    }
  }

  /**
   * Delete a message template
   */
  async deleteTemplate(wabaId: string, templateName: string): Promise<any> {
    try {
      const response = await this.client.delete(`/${wabaId}/message_templates`, {
        params: {
          name: templateName,
        },
      });
      return response.data;
    } catch (error: any) {
      console.error('Meta API Error - Delete Template:', error.response?.data || error.message);
      throw new HTTP500Error({
        message: 'Failed to delete template via Meta API',
        details: error.response?.data || error.message,
      });
    }
  }

  /**
   * Get WABA phone numbers
   */
  async getPhoneNumbers(wabaId: string): Promise<any> {
    try {
      const response = await this.client.get(`/${wabaId}/phone_numbers`);
      console.log("Response data",response.data)
      return response.data;
    } catch (error: any) {
      console.error('Meta API Error - Get Phone Numbers:', error.response?.data || error.message);
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
    try {
      const response = await this.client.get(`/${phoneNumberId}`, {
        params: {
          fields: 'id,verified_name,display_phone_number,quality_rating,code_verification_status',
        },
      });
      console.log("Response",response.data)
      return response.data;
    } catch (error: any) {
      console.error('Meta API Error - Get Phone Number Details:', error.response?.data || error.message);
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
      return response.data;
    } catch (error: any) {
      console.error('Meta API Error - Upload Media:', error.response?.data || error.message);
      throw new HTTP500Error({
        message: 'Failed to upload media to Meta API',
        details: error.response?.data || error.message,
      });
    }
  }

  /**
   * Get media URL
   */
  async getMediaUrl(mediaId: string): Promise<any> {
    try {
      const response = await this.client.get(`/${mediaId}`);
      return response.data;
    } catch (error: any) {
      console.error('Meta API Error - Get Media URL:', error.response?.data || error.message);
      throw new HTTP500Error({
        message: 'Failed to get media URL from Meta API',
        details: error.response?.data || error.message,
      });
    }
  }

  /**
   * Subscribe WABA Id
   */
  async subscribeToWebhooks(wabaId:any){
    try{
      const response = await this.client.get(`/${wabaId}/subscribed_apps`,{
      params : {
        subscribed_fields:'messages,message_deliveries,message_reads'
      }
      })
      return response.data;
    }catch(error:any){
      console.error('Meta API Error - Failed to subscribe to webhooks', error.response?.data || error.message);
      throw new HTTP500Error({
        message: 'Failed to fetch phone number details from Meta API',
        details: error.response?.data || error.message,
      });
    }
  }

  /**
   * Get WABA account details to verify it exists
   */
  async getWabaDetails(wabaId: string): Promise<any> {
    try {
      const response = await this.client.get(`/${wabaId}`, {
        params: {
          fields: 'id,name,currency,message_template_namespace,phone_numbers',
        },
      });
      return response.data;
    } catch (error: any) {
      console.error('Meta API Error - Get WABA Details:', error.response?.data || error.message);
      throw new HTTP500Error({
        message: 'Failed to verify WABA account with Meta API. Please check the WABA ID and access token.',
        details: error.response?.data || error.message,
      });
    }
  }
}

export default new MetaService();
