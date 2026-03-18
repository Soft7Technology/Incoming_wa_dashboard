import WabaModel from '@surefy/console/models/waba.model';
import PhoneNumberModel from '@surefy/console/models/phoneNumber.model';
import { CreateWabaDto, CreatePhoneNumberDto } from '@surefy/console/interfaces/waba.interface';
import MetaService from '@surefy/console/services/meta.service';
import HTTP404Error from '@surefy/exceptions/HTTP404Error';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';
import axios from "axios"
import wabaModel from '@surefy/console/models/waba.model';
import phoneNumberModel from '@surefy/console/models/phoneNumber.model';

class WabaService {
  /**
   * Onboard WABA accounts
   */
  async onboardWaba(data: CreateWabaDto) {
    try {
      // Step 1: Register WABA account in database
      const clientWabaAccount = await this.upsertWaba(data)
      console.log("✅ WABA Account registered with ID:", clientWabaAccount.id);

      // Step 2: Fetch phone numbers from Graph API and store
      const clientData = {
        company_id: data.company_id,
        waba_id: data.waba_id,
        company_WABAID: clientWabaAccount.id
      }

      const clientPhoneNumbers = await this.syncCompanyPhoneNumbers(clientData)
      console.log("✅ Phone numbers registered:", clientPhoneNumbers);

      // Step 3: Subscribe to webhooks
      const registeredWebhook = await MetaService.subscribeToWebhooks(clientData.waba_id)
      console.log("✅ Webhook subscription registered with ID:", registeredWebhook);

      return {
        clientAccountStatusMessage: "Client WABA account setup successfully",
        data: {
          clientWabaAccount,
          phoneNumbers: clientPhoneNumbers,
          webhook: registeredWebhook
        }
      };
    } catch (error: any) {
      throw new HTTP400Error({
        message: 'Failed to validate WABA with Meta API. Please check the WABA ID and ensure your access token has the correct permissions.',
        details: error.message,
      });
    }
  }


  async upsertWaba(data: CreateWabaDto) {
    const existing = await WabaModel.findByWabaId(data.waba_id);

    // Fetch latest data from Meta
    const wabaDetails = await MetaService.getWabaDetails(data.waba_id);

    if (existing) {
      return WabaModel.update(existing.id, {
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
    company_id: string;
    waba_id: string;
    company_WABAID: string;
  }) {
    const response = await MetaService.getPhoneNumbers(clientData.waba_id);
    const results = [];

    for (const phone of response.data || []) {
      const existing = await PhoneNumberModel.findByPhoneNumberId(phone.id);

      if (existing) {
        // Update status changes (very important)
        await PhoneNumberModel.update(existing.id, {
          quality_rating: phone.quality_rating,
          meta_data: phone,
          updated_at: new Date(),
        });
        results.push({ phone_id: phone.id, status: "updated" });
      } else {
        await PhoneNumberModel.create({
          company_id: clientData.company_id,
          waba_id: clientData.company_WABAID,
          phone_number_id: phone.id,
          display_phone_number: phone.display_phone_number,
          verified_name: phone.verified_name,
          quality_rating: phone.quality_rating,
          meta_data: phone,
        });
        results.push({ phone_id: phone.id, status: "created" });
      }
    }

    return results;
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
        const phonePayload: CreatePhoneNumberDto = {
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
    console.log("Webhook Subscription URL:", url, token);

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
  async getCompanyWabas(companyId: string) {
    return WabaModel.findByCompanyId(companyId);
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
  async getCompanyPhoneNumbers(companyId: string) {
    return PhoneNumberModel.findByCompanyId(companyId);
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
  async syncPhoneNumbers(companyId: string, wabaId: string) {
    const waba = await this.getWabaById(wabaId);
    const phoneNumbers = await MetaService.getPhoneNumbers(waba.waba_id);

    const synced = [];
    for (const phone of phoneNumbers.data || []) {
      const existing = await PhoneNumberModel.findByPhoneNumberId(phone.id);

      if (!existing) {
        const created = await PhoneNumberModel.create({
          company_id: companyId,
          waba_id: wabaId,
          phone_number_id: phone.id,
          display_phone_number: phone.display_phone_number,
          verified_name: phone.verified_name,
          quality_rating: phone.quality_rating,
          meta_data: phone,
        });
        synced.push(created);
      }
    }

    return synced;
  }

  /**
   * Update phone number
   */
  async updatePhoneNumber(id: string, data: any) {
    const phoneNumber = await PhoneNumberModel.findById(id);
    if (!phoneNumber) {
      throw new HTTP404Error({ message: 'Phone number not found' });
    }

    return PhoneNumberModel.update(id, { ...data, updated_at: new Date() });
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
}

export default new WabaService();
