import ReminderModel from '../models/reminder.model';
import {
  ReminderScope,
  ReminderRecord,
  ReminderInput,
  ReminderAction,
  BulkReminderInput,
  ReminderCreateRecord,
} from '../interfaces/reminder.interface';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';
import HTTP404Error from '@surefy/exceptions/HTTP404Error';
import { validate as isUuid } from 'uuid';
import PhoneNumberModel from '../models/phoneNumber.model';
import { buildRecipient } from '../utils/importPhone';
import { localTime, nextSend, templatePreview, resolveReminderMapping } from '../utils/reminder';

const validationError = (message: string): never => {
  throw new HTTP400Error({ message });
};
const validateResourceId = (id: unknown): string => {
  if (typeof id !== 'string' || !isUuid(id)) return validationError('Invalid resource ID');
  return id;
};
const resourceNotFound = (): never => {
  throw new HTTP404Error({ message: 'Reminder resource not found in your account' });
};

class ReminderService {
  private async getSendingNumber(scope: ReminderScope, id: string) {
    if (typeof id !== 'string' || !id) validationError('phone_number_id is required');
    const phone = await PhoneNumberModel.findByPhoneNumberId(id);
    if (!phone || phone.deleted_at || phone.user_id !== scope.ownerId || phone.company_id !== scope.companyId)
      resourceNotFound();
    if (phone.status !== 'active') validationError('Sending number must be active');
    return phone;
  }

  /** Return picker options with the variable keys required by each approved template. */
  async templates(scope: ReminderScope, phoneId: string) {
    const phone = await this.getSendingNumber(scope, phoneId);
    const templates = await ReminderModel.findApprovedTemplates(scope.companyId, phone.waba_id);
    return templates.map((template) => {
      const variables: Record<string, string> = {};
      for (const component of template.components || []) {
        const placeholders = String(component.text || '').matchAll(/{{\s*([\w]+)\s*}}/g);
        for (const placeholder of placeholders) {
          const variableKey = `${String(component.type).toLowerCase()}.${placeholder[1]}`;
          variables[variableKey] = `{{${placeholder[1]}}}`;
        }
      }
      const mediaHeader = (template.components || []).find(
        (component: any) => component.type === 'HEADER' && ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(component.format),
      );
      const previewMedia = mediaHeader
        ? [{ type: mediaHeader.format.toLowerCase(), url: 'https://example.com/preview' }]
        : [];
      try {
        return {
          id: template.id,
          name: template.name,
          language: template.language,
          category: template.category,
          components: template.components,
          supported: true,
          required_variables: templatePreview(template, variables, previewMedia).required_variables,
          required_parameter_mapping: [...new Set(Object.keys(variables).map((key) => key.split('.')[1]))],
          required_media_type: mediaHeader ? mediaHeader.format.toLowerCase() : null,
        };
      } catch (error: any) {
        return {
          id: template.id,
          name: template.name,
          language: template.language,
          supported: false,
          reason: error.message,
        };
      }
    });
  }

  /** Recheck ownership, opt-out and template approval at preview, save and send time. */
  async prepare(scope: ReminderScope, body: ReminderInput, checkTime = true) {
    if (!body || typeof body !== 'object') validationError('Reminder body is required');
    if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 255)
      validationError('name is required (maximum 255 characters)');
    const contact = await ReminderModel.findRecipient(scope, validateResourceId(body.contact_id));
    if (!contact) resourceNotFound();
    if (contact.is_opted_out || contact.is_valid === false) validationError('Contact is opted out or invalid');
    const phone = await this.getSendingNumber(scope, body.phone_number_id);
    if (contact.phone_number_id !== phone.id) validationError('Contact must belong to the selected sending number');
    const template = await ReminderModel.findApprovedTemplate(
      scope.companyId,
      phone.waba_id,
      validateResourceId(body.template_id),
    );
    if (!template) validationError('Select an approved template belonging to the sending number');
    try {
      if (typeof body.timezone !== 'string' || !body.timezone || body.timezone.length > 100)
        throw new Error('An IANA timezone is required');
      const next = checkTime ? nextSend(body.local_datetime, body.timezone, body.frequency) : null;
      const hasMapping = body.parameter_mapping !== undefined && body.parameter_mapping !== null;
      if (hasMapping && body.variables && Object.keys(body.variables).length) {
        throw new Error('Use either parameter_mapping or variables, not both');
      }
      const resolvedVariables = hasMapping
        ? resolveReminderMapping(template, contact, body.parameter_mapping!)
        : (body.variables ?? {});
      const rendered = templatePreview(template, resolvedVariables, body.media_uploads ?? []);
      const recipient = {
        id: contact.id,
        name: contact.name,
        country_code: contact.country_code,
        phone_number: contact.phone_number,
        whatsapp_number: buildRecipient(contact.phone_number, contact.country_code),
      };
      return {
        values: {
          name: body.name.trim(),
          contact_id: contact.id,
          phone_number_id: phone.id,
          template_id: template.id,
          frequency: body.frequency,
          timezone: body.timezone,
          local_datetime: body.local_datetime,
          variables: hasMapping ? {} : (body.variables ?? {}),
          parameter_mapping: body.parameter_mapping ?? null,
          media_uploads: body.media_uploads ?? [],
          next_send_at: next,
        },
        recipient,
        sending_number: {
          id: phone.id,
          whatsapp_number: phone.display_phone_number,
          meta_phone_number_id: phone.phone_number_id,
        },
        ...rendered,
        resolved_variables: resolvedVariables,
        next_send_at: next,
        next_send_local: next ? localTime(next, body.timezone) : null,
        timezone: body.timezone,
        phone,
        templateRecord: template,
      };
    } catch (error: any) {
      return validationError(error.message);
    }
  }

  async preview(scope: ReminderScope, body: ReminderInput) {
    const { phone, templateRecord, values, ...preview } = await this.prepare(scope, body);
    return preview;
  }

  private formatReminder(row: ReminderRecord) {
    return { ...row, next_send_local: row.next_send_at ? localTime(new Date(row.next_send_at), row.timezone) : null };
  }

  async create(scope: ReminderScope, body: ReminderInput) {
    const { values } = await this.prepare(scope, body);
    const row = await ReminderModel.create({ ...values, company_id: scope.companyId, user_id: scope.ownerId });
    return this.formatReminder(row);
  }

  /** Validate every recipient before persisting the batch in one atomic insert. */
  async createBulk(scope: ReminderScope, body: BulkReminderInput) {
    if (!body || !Array.isArray(body.contact_ids) || body.contact_ids.length < 1 || body.contact_ids.length > 100) {
      return validationError('contact_ids must contain between 1 and 100 contact IDs');
    }
    if (Object.prototype.hasOwnProperty.call(body, 'contact_id')) {
      return validationError('Use contact_ids instead of contact_id for bulk reminders');
    }
    const contactIds = body.contact_ids.map((id) => validateResourceId(id).toLowerCase());
    if (new Set(contactIds).size !== contactIds.length) {
      return validationError('contact_ids must not contain duplicates');
    }

    const records: ReminderCreateRecord[] = [];
    // Reuse single-recipient validation, including assignments, opt-out and mappings.
    for (const contactId of contactIds) {
      const { values } = await this.prepare(scope, { ...body, contact_id: contactId });
      records.push({ ...values, company_id: scope.companyId, user_id: scope.ownerId });
    }
    // Use one occurrence for the entire batch, even if validation crosses a date boundary.
    let nextSendAt: Date;
    try {
      nextSendAt = nextSend(body.local_datetime, body.timezone, body.frequency);
    } catch (error: any) {
      return validationError(error.message);
    }
    for (const record of records) record.next_send_at = nextSendAt;
    const reminders = await ReminderModel.createMany(records);
    return { created_count: reminders.length, items: reminders.map((reminder) => this.formatReminder(reminder)) };
  }

  async get(scope: ReminderScope, id: string) {
    const row = await ReminderModel.findOwned(scope, validateResourceId(id));
    if (!row) return resourceNotFound();
    return this.formatReminder(row);
  }

  async summary(scope: ReminderScope, timezone: unknown = 'UTC') {
    if (typeof timezone !== 'string' || !timezone.trim()) {
      throw new HTTP400Error({ message: 'timezone must be an IANA timezone such as Asia/Kolkata' });
    }
    try { timezone = new Intl.DateTimeFormat('en', { timeZone: timezone }).resolvedOptions().timeZone; }
    catch { throw new HTTP400Error({ message: 'Invalid timezone' }); }
    return ReminderModel.summary(scope, timezone as string);
  }

  async list(scope: ReminderScope, filter: any) {
    const { limit, offset } = this.pagination(filter);
    if (filter.status && !['upcoming', 'sending', 'sent', 'failed', 'paused', 'cancelled'].includes(filter.status)) {
      validationError('Invalid status');
    }
    const page = await ReminderModel.findPage(scope, {
      status: filter.status,
      contact_id: filter.contact_id ? validateResourceId(filter.contact_id) : undefined,
      limit,
      offset,
    });
    return { items: page.items.map((reminder) => this.formatReminder(reminder)), total: page.total, limit, offset };
  }

  /** Validate edits while holding the same row lock used by the scheduler. */
  async update(scope: ReminderScope, id: string, body: Partial<ReminderInput>) {
    const updated = await ReminderModel.updateOwned(scope, validateResourceId(id), async (reminder) => {
      if (!reminder) return resourceNotFound();
      if (!['upcoming', 'paused', 'failed'].includes(reminder.status)) {
        validationError('Only upcoming, paused or failed reminders can be edited');
      }
      const input = { ...reminder, ...body };
      // Switching formats replaces the old input; neither format silently wins.
      if (body.parameter_mapping !== undefined && body.variables === undefined) input.variables = {};
      if (body.variables !== undefined && body.parameter_mapping === undefined) input.parameter_mapping = null;
      const { values } = await this.prepare(scope, input);
      return { ...values, status: reminder.status === 'paused' ? 'paused' : 'upcoming' };
    });
    return this.formatReminder(updated);
  }

  /** Return a state transition; the model persists it atomically. */
  async action(scope: ReminderScope, id: string, action: ReminderAction) {
    const updated = await ReminderModel.updateOwned(scope, validateResourceId(id), async (reminder) => {
      if (!reminder) return resourceNotFound();
      if (reminder.status === 'sending') validationError('This occurrence has already started sending');
      if (action === 'cancel' && reminder.status === 'cancelled') return null;
      if (action === 'pause' && reminder.status === 'paused') return null;

      if (action === 'pause' && reminder.status === 'upcoming') return { status: 'paused' };
      if (action === 'cancel' && ['upcoming', 'paused', 'failed'].includes(reminder.status)) {
        return { status: 'cancelled', next_send_at: null };
      }
      if (action === 'resume' && reminder.status === 'paused') {
        const prepared = await this.prepare(scope, reminder);
        return { status: 'upcoming', next_send_at: prepared.next_send_at };
      }
      return validationError('Action is not allowed in the current state');
    });
    return this.formatReminder(updated);
  }

  /** Authorize the schedule before exposing its historical message data. */
  async history(scope: ReminderScope, id: string, filter: any) {
    await this.get(scope, id);
    const { limit, offset } = this.pagination(filter);
    return { items: await ReminderModel.findHistory(id, limit, offset), limit, offset };
  }

  private pagination(filter: { limit?: unknown; offset?: unknown }) {
    const limit = filter.limit === undefined ? 25 : Number(filter.limit);
    const offset = filter.offset === undefined ? 0 : Number(filter.offset);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) {
      validationError('Invalid pagination');
    }
    return { limit, offset };
  }
}
export default new ReminderService();
