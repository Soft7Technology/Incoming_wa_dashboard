import db from '@surefy/database';
import { parseSpreadsheetPhone } from '../utils/importPhone';
import { FlowScope, fail, hash, uuid } from '../utils/automationFlow';
import { renderAutomationTemplate } from '../utils/automationTemplate';

/** Same run + step always maps to the same message id, so a step can never send twice. */
function stableMessageId(runId: string, stepId: string) {
  const h = hash(`automation-whatsapp:${runId}:${stepId}`);
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function recipient(to: string, countryCode?: string) {
  const cc = typeof countryCode === 'string' ? countryCode.trim().replace(/^\+/, '') : '';
  if (cc && !/^[1-9]\d{0,2}$/.test(cc)) fail(400, 'country_code must be 1-3 digits, e.g. 91');
  try {
    const identity = parseSpreadsheetPhone(to.trim(), cc);
    return identity.country_code + identity.phone_number;
  } catch {
    return fail(400, 'Invalid recipient phone number. Use international format (e.g. +919876543210) or set country_code.');
  }
}

/** Meta/axios errors aren't operational; surface Meta's reason without internals. */
function providerFailure(error: any): never {
  if (error?.isOperational === true) throw error;
  if (error?.code === 'CONTACT_OPTED_OUT') fail(409, 'The recipient has opted out of messages from this number');
  const reason = error?.response?.data?.error?.error_user_msg || error?.response?.data?.error?.message;
  return fail(502, `WhatsApp didn't accept the message${reason ? `: ${String(reason).slice(0, 300)}` : ''}. Check the message status before retrying.`);
}

/**
 * Flow actions that send a WhatsApp message from the step's connection
 * (an active phone_numbers row owned by the flow's account).
 */
export class AutomationWhatsAppService {
  constructor(private readonly database = db) {}

  /** Validate the recipient, opt-out and template without creating or sending a message. */
  async prepare(scope: FlowScope, phone: any, step: any, parameters: Record<string, any>) {
    if (phone.company_id !== scope.companyId || phone.user_id !== scope.userId || phone.status !== 'active' || phone.deleted_at) fail(404, 'Select an active WhatsApp number from your account');
    if (!['sendTemplate', 'sendText'].includes(step.key)) fail(400, 'Unsupported WhatsApp flow action');
    for (const field of ['contact_name', 'contact_email']) {
      const value = parameters[field];
      if (value !== undefined && (typeof value !== 'string' || !value.trim() || value.trim().length > 255)) fail(400, `${field} must contain 1-255 characters`);
    }
    if (parameters.contact_email !== undefined && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(parameters.contact_email.trim())) fail(400, 'contact_email must be a valid email address');

    const to = recipient(String(parameters.to ?? ''), parameters.country_code);
    const optOut = (await import('./contactOptOut.service')).default;
    if (await optOut.isBlocked(phone, to)) fail(409, 'The recipient has opted out of messages from this number');

    let template: any = null;
    let payload: any;
    if (step.key === 'sendTemplate') {
      template = await this.database('templates')
        .where({ id: uuid(parameters.template_id, 'template_id'), company_id: phone.company_id, waba_id: phone.waba_id, status: 'APPROVED' })
        .whereNull('deleted_at')
        .first();
      if (!template) fail(400, 'Select an approved template that belongs to this WhatsApp number');
      payload = { type: 'template', template: renderAutomationTemplate(template, parameters.variables ?? {}) };
      await (await import('./automationContact.service')).default.check(scope, phone, to);
    } else {
      payload = { type: 'text', text: { body: String(parameters.message), preview_url: false } };
    }
    return { to, template, payload };
  }

  async execute(scope: FlowScope, phone: any, step: any, parameters: Record<string, any>, runId: string) {
    if (phone.company_id !== scope.companyId || phone.user_id !== scope.userId || phone.status !== 'active' || phone.deleted_at) fail(404, 'Select an active WhatsApp number from your account');
    const messageId = stableMessageId(runId, step._id);
    // Already attempted in this run: report confirmation, never call Meta again.
    const prior = await this.database('messages').where({ id: messageId }).first('id', 'wamid', 'status', 'to_phone');
    if (prior) {
      if (!prior.wamid) fail(409, 'This message was already attempted without a confirmed WhatsApp ID; check its status before starting another run');
      return { message_id: prior.id, wamid: prior.wamid, status: prior.status, to: prior.to_phone, replayed: true };
    }
    const { to, template, payload } = await this.prepare(scope, phone, step, parameters);
    const contactResult = template ? await (await import('./automationContact.service')).default.ensure(scope, phone, to, {
      name: parameters.contact_name?.trim(), email: parameters.contact_email?.trim(),
    }) : null;

    const messages = (await import('./message.service')).default;
    let sent: any;
    try {
      sent = await messages.sendMessage(
        {
          user_id: phone.user_id,
          company_id: phone.company_id,
          phone_number_id: phone.id,
          messageUUID: messageId,
          campaign_id: null,
          profile_name: contactResult?.contact.name || '',
          to,
          ...payload,
        },
        { phoneNumber: phone, ...(template ? { templateRecord: template } : {}), allowUnverifiedRecipient: true, source: 'automation' },
      );
    } catch (error) {
      providerFailure(error);
    }
    return {
      message_id: sent.id,
      wamid: sent.wamid || null,
      status: sent.wamid ? 'sent' : 'unknown',
      to,
      from: phone.display_phone_number,
      type: payload.type,
      ...(template ? { template: template.name, language: template.language } : {}),
      ...(contactResult ? { contact_id: contactResult.contact.id, contact_created: contactResult.created } : {}),
    };
  }
}

export default new AutomationWhatsAppService();
