import TemplateModel from '@surefy/console/models/template.model';
import WabaModel from '@surefy/console/models/waba.model';
import { CreateTemplateDto } from '@surefy/console/interfaces/template.interface';
import MetaService from '@surefy/console/services/meta.service';
import HTTP404Error from '@surefy/exceptions/HTTP404Error';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';

class TemplateService {
  /**
   * Sync templates from Meta
   */
  async syncTemplates(userId: string, wabaId: string) {
    const waba = await WabaModel.findById(wabaId);
    if (!waba) {
      throw new HTTP404Error({ message: 'WABA account not found' });
    }

    // Fetch templates from Meta
    const metaTemplates = await MetaService.getTemplates(waba.waba_id);

    const synced = [];
    for (const template of metaTemplates.data || []) {
      const existing = await TemplateModel.findByNameAndLanguage(
        userId,
        template.name,
        template.language,
      );

      const templateData = {
        user_id: userId,
        waba_id: wabaId,
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
    // Get WABA to get waba_id for Meta API
    const waba = await WabaModel.findById(data.waba_id);
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
      waba_id: data.waba_id,
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
  async getTemplates(userId: string, filters: any = {}) {
    return TemplateModel.findByCompanyId(userId, filters);
  }

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
