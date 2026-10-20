import WabaModel from '@surefy/console/models/waba.model';
import PhoneNumberModel from '@surefy/console/models/phoneNumber.model';
import { CreateWabaDto, CreatePhoneNumberDto } from '@surefy/console/interfaces/waba.interface';
import MetaService from '@surefy/console/services/meta.service';
import HTTP404Error from '@surefy/exceptions/HTTP404Error';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';
import axios from "axios"
import wabaModel from '@surefy/console/models/waba.model';
import phoneNumberModel from '@surefy/console/models/phoneNumber.model';
import metaService from '@surefy/console/services/meta.service';
import activityLogsModel from '../models/activityLogs.model';
import contactListModel from '../models/contactList.model';
import ImportJobModel from "../models/importJob.model"
import { validate as uuidValidate } from 'uuid';
import planUsage, { checkUsage } from './planUsage.service';
import wabaCredentials from './wabaCredentials.service';
import { WabaGraph } from './wabaGraph.service';
import { WabaOnboardingError } from '../utils/wabaOnboarding';

export interface WabaSyncClient {
  getWabaDetails(id: string): Promise<any>;
  getPhoneNumbers(id: string): Promise<any>;
}

class WabaService {
  /** Refresh an already connected WABA using its Meta ID or local UUID. */
  async syncWaba(userId: string, companyId: string, wabaId: string, authorizedClient?: WabaSyncClient) {
    if (!userId || !companyId) throw new HTTP400Error({ message: 'User and company context are required' });
    if (typeof wabaId !== 'string' || wabaId.length > 255 ||
        (!/^\d+$/.test(wabaId) && !uuidValidate(wabaId))) {
      throw new HTTP400Error({ message: 'wabaId must be a Meta WABA ID or an internal WABA UUID' });
    }
    const waba = await WabaModel.findOwnedForSync(wabaId, userId, companyId);
    if (!waba || waba.deleted_at || waba.user_id !== userId || waba.company_id !== companyId) {
      throw new HTTP404Error({ message: 'WABA not found in your account' });
    }
    const savedToken = authorizedClient ? null : await wabaCredentials.forAccount(userId, companyId, waba.id);
    if (!authorizedClient && !savedToken && waba.connection_status && waba.connection_status !== 'legacy') throw new WabaOnboardingError(
      'WABA_SETUP_REQUIRED', 'Finish the saved onboarding or reconnect this WhatsApp account before syncing.', false, 403);
    const client = authorizedClient || (savedToken ? new WabaGraph(savedToken) : MetaService);
    // Complete both remote reads before starting the database transaction.
    const [details, response] = await Promise.all([
      client.getWabaDetails(waba.waba_id), client.getPhoneNumbers(waba.waba_id),
    ]);
    if (!details || details.id !== waba.waba_id || !Array.isArray(response?.data)) {
      throw new HTTP400Error({ message: 'Invalid WABA sync response from Meta' });
    }
    const phones = new Map<string, any>();
    for (const phone of response.data) {
      if (!phone || typeof phone.id !== 'string' || !/^\d+$/.test(phone.id) ||
          typeof phone.display_phone_number !== 'string' || !phone.display_phone_number.trim()) {
        throw new HTTP400Error({ message: 'Invalid phone number response from Meta' });
      }
      phones.set(phone.id, phone);
    }
    return WabaModel.syncAccountAndPhones(waba, details, [...phones.values()]);
  }

  /** Compatibility entry point; all onboarding uses the durable Embedded Signup flow. */
  async onboardWaba(data: CreateWabaDto & { code?: string; state?: string | null; phone_number_id?: string | null }) {
    const { default: onboarding } = await import('./wabaOnboarding.service');
    return onboarding.begin({ userId: data.user_id, companyId: data.company_id! }, data);
  }

  async upsertWaba(data: CreateWabaDto) {
    const existing = await WabaModel.findByWabaId(data.waba_id);

    if (!data.user_id || !data.company_id) throw new HTTP400Error({ message: 'User and company context are required' });
    if (existing && (existing.user_id !== data.user_id || existing.company_id !== data.company_id)) {
      throw new HTTP400Error({ message: 'WABA is already connected to another account' });
    }
    // Fetch latest data from Meta
    const wabaDetails = await MetaService.getWabaDetails(data.waba_id);

    if (existing) {
      return WabaModel.update(existing.id, {
        user_id: data.user_id,
        company_id: data.company_id,
        name: wabaDetails.name,
        currency: wabaDetails.currency,
        timezone: wabaDetails.timezone,
        meta_data: {
          ...existing.meta_data,
          ...wabaDetails,
        },
        updated_at: new Date(),
      });
    }

    return WabaModel.create({
      ...data,
      name: data.name || wabaDetails.name,
      currency: data.currency || wabaDetails.currency,
      timezone: data.timezone || wabaDetails.timezone,
      meta_data: wabaDetails,
    });
  }


  async syncCompanyPhoneNumbers(clientData: {
    user_id: string;
    company_id?: string;
    waba_id: string;
    company_WABAID: string;
  }) {
    if (!clientData.company_id) throw new HTTP400Error({ message: 'Company context is required' });
    const result = await this.syncWaba(clientData.user_id, clientData.company_id, clientData.company_WABAID);
    return result.phone_numbers;
  }



  async registerPhoneNumber(clientData: {
    company_id: string;
    waba_id: string;
    company_WABAID: string;
  }) {
    try {
      // 1️⃣ Fetch phone numbers from Meta
      const response = await MetaService.getPhoneNumbers(clientData.waba_id);

      if (!response?.data || !Array.isArray(response.data)) {
        throw new HTTP400Error({
          message: 'Invalid phone number response from Meta',
        });
      }

      const registeredPhoneNumbers = [];

      // 2️⃣ Loop phone numbers ONE BY ONE
      for (const phone of response.data) {
        const parentWaba = await this.getWabaById(clientData.company_WABAID);
        const phonePayload: CreatePhoneNumberDto = {
          user_id: parentWaba.user_id,
          company_id: clientData.company_id,
          waba_id: clientData.company_WABAID, // internal WABA ID
          phone_number_id: phone.id,
          display_phone_number: phone.display_phone_number,
          verified_name: phone.verified_name || '',
          quality_rating: phone.quality_rating,
          status: phone.code_verification_status,
          meta_data: phone
        };

        try {
          // 3️⃣ Reuse existing method (best practice)
          const savedPhone = await this.addPhoneNumber(phonePayload);
          registeredPhoneNumbers.push(savedPhone);
        } catch (err: any) {
          // Ignore duplicates safely
          if (!err.message?.includes('already registered')) {
            throw err;
          }
        }
      }

      return registeredPhoneNumbers;

    } catch (error: any) {
      throw new HTTP400Error({
        message: 'Failed to register phone numbers',
        details: error.message,
      });
    }
  }

  /**
   * Create WABA account
   */
  async createWaba(data: CreateWabaDto) {
    if (!data.user_id || !data.company_id) throw new HTTP400Error({ message: 'User and company context are required' });
    // Check if WABA ID already exists in our database
    const existing = await WabaModel.findByWabaId(data.waba_id);
    if (existing) {
      throw new HTTP400Error({ message: 'WABA account already exists' });
    }

    // Validate WABA ID with Meta API before saving
    try {
      const wabaDetails = await MetaService.getWabaDetails(data.waba_id);

      // Create WABA with details from Meta
      return WabaModel.create({
        ...data,
        name: data.name || wabaDetails.name,
        currency: data.currency || wabaDetails.currency,
        timezone: data.timezone || wabaDetails.timezone,
        meta_data: {
          ...data.meta_data,
          ...wabaDetails,
        },
      });
    } catch (error: any) {
      throw new HTTP400Error({
        message: 'Failed to validate WABA with Meta API. Please check the WABA ID and ensure your access token has the correct permissions.',
        details: error.message,
      });
    }
  }

  private async _subscribeToWebhooks(waba_id: any) {
    console.log("Subscribing to webhooks for WABA ID:", waba_id);

    const token = process.env.META_ACCESS_TOKEN

    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    }

    const fields = "messages,message_deliveries,message_reads"
    const url = `https://graph.facebook.com/${process.env.API_VERSION}/${waba_id}/subscribed_apps?subscribed_fields=${fields}`;
    // Never log server credentials or HTTP response/config objects.

    try {
      const response = await axios.post(url, null, { headers })
      if (!response) {
        throw new Error("Failed to subscribe to webhooks");
      }

      console.log("Successfully subscribed to webhooks:", response.data);

      return response.data;
    } catch (error: any) {
      console.error("Error subscribing to webhooks:", error.message);
      throw error;
    }
  }



  /**
   * Get WABA accounts for company
   */
  async getCompanyWabas(userId: string, companyId: string) {
    return WabaModel.findByUserId(userId, companyId);
  }

  /**
   * Get WABA by ID
   */
  async getWabaById(id: string) {
    const waba = await WabaModel.findById(id);
    if (!waba) {
      throw new HTTP404Error({ message: 'WABA account not found' });
    }
    return waba;
  }

  /**
   * Add phone number to WABA
   */
  async addPhoneNumber(data: CreatePhoneNumberDto) {
    const waba = await this.getWabaById(data.waba_id);
    if (!data.user_id || !data.company_id || waba.user_id !== data.user_id || waba.company_id !== data.company_id) {
      throw new HTTP404Error({ message: 'WABA not found in your account' });
    }
    // Verify phone number exists in Meta
    try {
      const phoneDetails = await MetaService.getPhoneNumberDetails(data.phone_number_id);

      // Check if phone number already exists
      const existing = await PhoneNumberModel.findByPhoneNumberId(data.phone_number_id);
      if (existing) {
        throw new HTTP400Error({ message: 'Phone number already registered' });
      }

      return PhoneNumberModel.create({
        ...data,
        verified_name: phoneDetails.verified_name,
        quality_rating: phoneDetails.quality_rating,
        meta_data: phoneDetails,
      });
    } catch (error: any) {
      throw new HTTP400Error({
        message: 'Failed to verify phone number with Meta',
        details: error.message,
      });
    }
  }

  /**
   * Get phone numbers for company
   */
  async getUserPhoneNumbers(userId: string, companyId?: string) {
    return PhoneNumberModel.findByUserId(userId, companyId);
  }

  /**
   * Get phone numbers for WABA
   */
  async getWabaPhoneNumbers(wabaId: string) {
    return PhoneNumberModel.findByWabaId(wabaId);
  }

  /**
   * Sync phone numbers from Meta
   */
  async syncPhoneNumbers(companyId: string, wabaId: string, userId: string) {
    const result = await this.syncWaba(userId, companyId, wabaId);
    return result.phone_numbers;
  }

  /**
   * Update phone number
   */
  async updatePhoneNumber(id: string, data: any) {
    const phoneNumber = await PhoneNumberModel.findById(id);
    if (!phoneNumber) {
      throw new HTTP404Error({ message: 'Phone number not found' });
    }

    if (data.active !== undefined && typeof data.active !== 'boolean') {
      throw new HTTP400Error({ message: 'active must be a boolean' });
    }
    if (data.active !== undefined && ['active', 'inactive'].includes(data.status) &&
        data.active !== (data.status === 'active')) {
      throw new HTTP400Error({ message: 'active and status must agree' });
    }
    // Explicitly allow metadata fields; clients cannot restore deleted numbers or change ownership.
    const changes: Record<string, any> = {};
    for (const key of ['verified_name', 'status', 'messaging_limit_tier', 'capabilities']) {
      if (data[key] !== undefined) changes[key] = data[key];
    }
    const active = data.active ?? (data.status === 'active' ? true : data.status === 'inactive' ? false : undefined);
    if (active !== undefined) {
      changes.active = active;
      changes.inactive_reason = active ? null : 'MANUALLY_DISABLED';
    }
    if (active === true) {
      return planUsage.run(phoneNumber.user_id, 'WabaNumber', async (trx, plan) => {
        const current = await trx('phone_numbers').where({ id }).whereNull('deleted_at').forUpdate().first();
        if (!current) throw new HTTP404Error({ message: 'Phone number not found' });
        if (!current.active) checkUsage(plan, 'WabaNumber', 1);
        const [updated] = await trx('phone_numbers').where({ id }).update({ ...changes, updated_at: new Date() }).returning('*');
        return updated;
      }, 0);
    }
    return PhoneNumberModel.update(id, { ...changes, updated_at: new Date() });
  }

  /**
   * Delete phone number
   */
  async deletePhoneNumber(id: string) {
    const phoneNumber = await PhoneNumberModel.findById(id);
    if (!phoneNumber) {
      throw new HTTP404Error({ message: 'Phone number not found' });
    }

    return PhoneNumberModel.update(id, { deleted_at: new Date() });
  }

  async verifyNumber(phoneNumberId: string) {
    const verifyNumber = await metaService.verifiedPhoneNumbers(phoneNumberId)
    return verifyNumber
  }

  async deleteWabaAccount(wabaId: string) {
    // Get all phone numbers belonging to the WABA
    const phoneNumbers = await phoneNumberModel.findByWabaId(wabaId);

    // Delete dependent contact lists first
    for (const phoneNumber of phoneNumbers) {
      await contactListModel.deleteByPhoneNumberId(phoneNumber.id);
      await ImportJobModel.deleteByPhoneNumberId(phoneNumber.id);
      await phoneNumberModel.delete(phoneNumber.id);
    }

    // Delete phone numbers
    // for (const phoneNumber of phoneNumbers) {
    //   await phoneNumberModel.delete(phoneNumber.id);
    // }

    // Finally delete WABA account
    const deletedWaba = await wabaModel.delete(wabaId);

    return deletedWaba;
  }
}

export default new WabaService();
