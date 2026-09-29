import TemplateModel from '@surefy/console/models/template.model';
import WabaModel from '@surefy/console/models/waba.model';
import { CreateTemplateDto, UpdateTemplateDto, TemplateAccount } from '../interfaces/template.interface';
import MetaService from './meta.service';
import HTTP404Error from '@surefy/exceptions/HTTP404Error';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';
import phoneNumberModel from '../models/phoneNumber.model';
import { validateTemplatePayload } from '../utils/templateValidation';
import { validate as isUUID } from 'uuid';

class TemplateService {
  /** Resolve local/Meta WABA IDs and legacy phone IDs, then verify account ownership. */
  private async resolveWaba(identifier: string, account: TemplateAccount) {
    if (!account.companyId || !account.userId || typeof identifier !== 'string' || !identifier) {
      throw new HTTP400Error({ message: 'WABA ID and authenticated account are required' });
    }
    let waba = isUUID(identifier) ? await WabaModel.findById(identifier) : await WabaModel.findByWabaId(identifier);
    if (!waba) {
      const phone = await phoneNumberModel.findByPhoneNumberId(identifier);
      if (phone?.waba_id) waba = isUUID(phone.waba_id) ? await WabaModel.findById(phone.waba_id) : await WabaModel.findByWabaId(phone.waba_id);
    }
    if (!waba || waba.deleted_at || waba.company_id !== account.companyId || waba.user_id !== account.userId) {
      throw new HTTP404Error({ message: 'WABA account not found' });
    }
    return waba;
  }

  async syncTemplates(userId: string, wabaId: string, companyId?: string) {
    const waba = await this.resolveWaba(wabaId, { userId, companyId: companyId! });
    const response = await MetaService.getTemplates(waba.waba_id);
    const synced = [];
    for (const template of response.data || []) {
      const existing = await TemplateModel.findByNameAndLanguage(companyId!, template.name, template.language, waba.id);
      const data = {
        company_id: companyId, waba_id: waba.id, template_id: template.id,
        name: template.name, language: template.language, category: template.category,
        status: template.status, components: template.components, meta_data: template, synced_at: new Date(),
      };
      synced.push(existing ? await TemplateModel.update(existing.id, data) : await TemplateModel.create(data));
    }
    return synced;
  }

  /** Each language is a separate Meta template with its own ID and approval status. */
  async createTemplate(data: CreateTemplateDto) {
    validateTemplatePayload(data, true);
    const waba = await this.resolveWaba(data.waba_id, { companyId: data.company_id, userId: data.user_id });
    const existing = await TemplateModel.findByNameAndLanguage(data.company_id, data.name, data.language, waba.id);
    if (existing) throw new HTTP400Error({ message: 'This template name and language already exist in the WABA' });
    const { name, language, category, components, parameter_format, message_send_ttl_seconds } = data;
    const result = await MetaService.createTemplate(waba.waba_id, {
      name, language, category, components, parameter_format, message_send_ttl_seconds,
    });
    return TemplateModel.create({
      company_id: data.company_id, waba_id: waba.id,
      template_id: result.id, name, language, category: result.category || category,
      status: result.status || 'PENDING', components,
      meta_data: { ...result, parameter_format, message_send_ttl_seconds },
    });
  }

  async getTemplates(userId: string, companyId?: string, wabaId?: string, phoneId?: string, filters: any = {}) {
    if (!companyId || !userId) throw new HTTP400Error({ message: 'Authenticated account is required' });
    const identifier = phoneId || wabaId;
    const waba = identifier ? await this.resolveWaba(identifier, { userId, companyId }) : undefined;
    return TemplateModel.findByCompanyId(userId, companyId, waba?.id, filters);
  }

  async getTemplateById(id: string, account: TemplateAccount) {
    if (!isUUID(id)) throw new HTTP400Error({ message: 'Use the local template UUID' });
    const template = await TemplateModel.findById(id);
    if (!template || template.deleted_at || template.company_id !== account.companyId) throw new HTTP404Error({ message: 'Template not found' });
    await this.resolveWaba(template.waba_id, account);
    return template;
  }

  async updateTemplate(id: string, data: UpdateTemplateDto, account: TemplateAccount) {
    validateTemplatePayload(data);
    const template = await this.getTemplateById(id, account);
    if (!template.template_id) throw new HTTP400Error({ message: 'Sync this template with Meta before editing' });
    // Read current Meta state; a locally cached approval may already be stale.
    const current = await MetaService.getTemplate(template.template_id);
    if (!['APPROVED', 'REJECTED', 'PAUSED'].includes(current.status)) {
      throw new HTTP400Error({ message: `Templates with status ${current.status} cannot be edited` });
    }
    if (current.status === 'APPROVED' && data.category && data.category !== current.category) {
      throw new HTTP400Error({ message: 'The category of an approved template cannot be changed' });
    }
    const payload = { ...data };
    if (current.status === 'APPROVED') delete payload.category;
    if (!Object.keys(payload).length) throw new HTTP400Error({ message: 'No template changes supplied' });
    await MetaService.updateTemplate(template.template_id, payload);
    // Never keep a previous APPROVED state after replacing its content.
    await TemplateModel.update(id, { ...payload, message_send_ttl_seconds: undefined,
      status: 'PENDING', meta_data: { ...current, ...payload, status: 'PENDING' }, synced_at: null });
    const updated = await MetaService.getTemplate(template.template_id);
    return TemplateModel.update(id, {
      category: updated.category, components: updated.components, status: updated.status,
      meta_data: updated, synced_at: new Date(),
    });
  }

  async deleteTemplate(id: string, account: TemplateAccount) {
    const template = await this.getTemplateById(id, account);
    const waba = await this.resolveWaba(template.waba_id, account);
    if (!template.template_id) throw new HTTP400Error({ message: 'Sync this template with Meta before deleting' });
    // Deleting by name alone would delete every language variant.
    await MetaService.deleteTemplate(waba.waba_id, template.name, template.template_id);
    return TemplateModel.update(id, { deleted_at: new Date() });
  }
}

export default new TemplateService();
