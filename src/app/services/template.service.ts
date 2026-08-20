import TemplateModel from '@surefy/console/models/template.model';
import WabaModel from '@surefy/console/models/waba.model';
import { CreateTemplateDto } from '@surefy/console/interfaces/template.interface';
import MetaService from '@surefy/console/services/meta.service';
import HTTP404Error from '@surefy/exceptions/HTTP404Error';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';
import phoneNumberModel from '../models/phoneNumber.model';

class TemplateService {
  /**
   * Sync templates from Meta
   */
  async syncTemplates(userId: string, wabaId: string, companyId?: string) {
    // Add the same UUID check here:
    const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(wabaId);
    let waba = null;
    if (isUUID) {
      waba = await WabaModel.findById(wabaId);
      if (!waba) {
        const phone = await phoneNumberModel.findByPhoneNumberId(wabaId);
        if (phone?.waba_id) {
          waba = await WabaModel.findById(phone.waba_id) || await WabaModel.findByWabaId(phone.waba_id);
        }
      }
    }
    if (!waba) {
      waba = await WabaModel.findByWabaId(wabaId);
    }
    if (!waba) {
      const phone = await phoneNumberModel.findByPhoneNumberId(wabaId);
      if (phone?.waba_id) {
        waba = await WabaModel.findById(phone.waba_id) || await WabaModel.findByWabaId(phone.waba_id);
      }
    }
    if (!waba) {
      throw new HTTP404Error({ message: 'WABA account not found' });
    }

    // Fetch templates from Meta
    const metaTemplates = await MetaService.getTemplates(waba.waba_id);

    const synced = [];
    for (const template of metaTemplates.data || []) {
      const existing = await TemplateModel.findByNameAndLanguage(
        companyId || userId,
        template.name,
        template.language,
      );

      const templateData = {
        user_id: userId,
        company_id: companyId,
        waba_id: waba.id,
        template_id: template.id,
        name: template.name,
        language: template.language,
        category: template.category,
        status: template.status,
        components: template.components,
        meta_data: template,
        synced_at: new Date(),
      };

      if (existing) {
        const updated = await TemplateModel.update(existing.id, templateData);
        synced.push(updated);
      } else {
        const created = await TemplateModel.create(templateData);
        synced.push(created);
      }
    }

    return synced;
  }

  /**
   * Create new template
   */
  async createTemplate(data: CreateTemplateDto) {
    // 1. Check if waba_id is UUID or Meta WABA ID string
    const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(data.waba_id);
    let waba = null;
    if (isUUID) {
      waba = await WabaModel.findById(data.waba_id);
      // Fallback: Check if the passed UUID is actually a phone_number ID from phone_numbers table
      if (!waba) {
        const phone = await phoneNumberModel.findByPhoneNumberId(data.waba_id);
        if (phone?.waba_id) {
          waba = await WabaModel.findById(phone.waba_id) || await WabaModel.findByWabaId(phone.waba_id);
        }
      }
    }
    if (!waba) {
      waba = await WabaModel.findByWabaId(data.waba_id);
    }
    if (!waba) {
      // Check phone number by phone_number_id string
      const phone = await phoneNumberModel.findByPhoneNumberId(data.waba_id);
      if (phone?.waba_id) {
        waba = await WabaModel.findById(phone.waba_id) || await WabaModel.findByWabaId(phone.waba_id);
      }
    }
    if (!waba) {
      throw new HTTP404Error({ message: 'WABA account not found' });
    }


    // Create template in Meta
    const metaTemplate = await MetaService.createTemplate(waba.waba_id, {
      name: data.name,
      language: data.language,
      category: data.category,
      components: data.components,
    });

    // Save to database
    return TemplateModel.create({
      company_id: data.company_id,
      waba_id: waba.id,
      template_id: metaTemplate.id,
      name: data.name,
      language: data.language,
      category: data.category,
      status: metaTemplate.status || 'PENDING',
      components: data.components,
      meta_data: metaTemplate,
    });
  }

  /**
   * Get templates for company
   */
<<<<<<< HEAD
  async getTemplates(userId: string, companyId?: string, waba_id?: any, phone_number_id?: any, filters: any = {}) {
    let targetWabaId = waba_id;

    if (phone_number_id) {
      if (phoneNumber?.waba_id) targetWabaId = phoneNumber.waba_id;
    } else if (waba_id) {
      const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(waba_id);
      if (isUUID) {
        const waba = await WabaModel.findById(waba_id);
        if (waba) {
          targetWabaId = waba.id;
        } else {
          const phone = await phoneNumberModel.findByPhoneNumberId(waba_id);
          if (phone?.waba_id) {
            targetWabaId = phone.waba_id;
          }
        }
      } else {
        const waba = await WabaModel.findByWabaId(waba_id);
        if (waba) {
          targetWabaId = waba.id;
        } else {
          const phone = await phoneNumberModel.findByPhoneNumberId(waba_id);
          if (phone?.waba_id) {
            targetWabaId = phone.waba_id;
          }
        }
      }
=======
  async getTemplates(userId: string,companyId?:string,waba_id?:any,phone_number_id?:any,filters: any = {}) {
    console.log("Details",phone_number_id,waba_id)
    if(phone_number_id){
      const phoneNumber  = await phoneNumberModel.findByPhoneNumberId(phone_number_id)

  /**
   * Get template by ID
   */
  async getTemplateById(id: string) {
    const template = await TemplateModel.findById(id);
    if (!template) {
      throw new HTTP404Error({ message: 'Template not found' });
    }
    return template;
  }

  /**
   * Delete template
   */
  async deleteTemplate(id: string) {
    const template = await this.getTemplateById(id);

    // Get WABA
    const waba = await WabaModel.findById(template.waba_id);

    // Delete from Meta
    try {
      await MetaService.deleteTemplate(waba.waba_id, template.name);
    } catch (error) {
      console.error('Failed to delete template from Meta:', error);
    }

    // Soft delete from database
    return TemplateModel.update(id, { deleted_at: new Date() });
  }
}

export default new TemplateService();
