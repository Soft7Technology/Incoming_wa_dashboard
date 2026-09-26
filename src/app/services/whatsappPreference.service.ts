import db from '@surefy/database';
import { Knex } from 'knex';
import { randomUUID } from 'crypto';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';
import HTTP404Error from '@surefy/exceptions/HTTP404Error';
import { buildRecipient, parseImportedPhone, parseWhatsAppPhone } from '../utils/importPhone';
import { affirmativeConsentReply, enforcePreferencePolicy, preferenceCommand, staffPreferenceSources,
  PreferenceScope, PreferenceStatus, WhatsAppSuppressedError } from '../utils/whatsappPreference';

export interface WhatsAppSendContext {
  businessInitiated?: boolean;
  preferenceReply?: { receiptId: string; token: string };
}
interface Change {
  scope: PreferenceScope; status: PreferenceStatus; source: string; evidence: Record<string, any>;
  wamid?: string; staffUserId?: string; occurredAt?: Date;
}

export class WhatsAppPreferenceService {
  constructor(private database: Knex = db) {}

  private recipient(contact: any) {
    const identity = parseImportedPhone(contact.phone_number, contact.country_code || '', Boolean(contact.country_code));
    return buildRecipient(identity.phone_number, identity.country_code);
  }
  private async lock(trx: Knex.Transaction, companyId: string, recipient: string) {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [JSON.stringify(['whatsapp-preference', companyId, recipient])]);
  }
  private async current(query: Knex | Knex.Transaction, companyId: string, recipient: string) {
    // A newer company-wide decision supersedes an older decision recorded on another sender's contact.
    return query('whatsapp_preferences').where({ company_id: companyId, recipient })
      .distinctOn('scope').orderBy('scope').orderBy('event_id', 'desc');
  }
  private async change(trx: Knex.Transaction, contact: any, recipient: string, input: Change) {
    const current = await this.current(trx, contact.company_id, recipient);
    const previous = current.find(row => row.scope === input.scope)?.status ?? null;
    const [event] = await trx('whatsapp_preference_events').insert({
      company_id: contact.company_id, contact_id: contact.id, recipient, scope: input.scope,
      previous_status: previous, new_status: input.status, source: input.source,
      evidence: JSON.stringify(input.evidence), wamid: input.wamid ?? null,
      staff_user_id: input.staffUserId ?? null, occurred_at: input.occurredAt ?? new Date(),
    }).returning('*');
    await trx('whatsapp_preferences').insert({
      company_id: contact.company_id, contact_id: contact.id, recipient, scope: input.scope,
      status: input.status, source: input.source, evidence: JSON.stringify(input.evidence), event_id: event.id,
    }).onConflict(['company_id', 'contact_id', 'scope']).merge({
      recipient, status: input.status, source: input.source, evidence: JSON.stringify(input.evidence),
      event_id: event.id, updated_at: trx.fn.now(),
    });
    return event;
  }

  private async contact(companyId: string, contactId: string, ownerId?: string) {
    const query = this.database('contacts').where({ company_id: companyId, id: contactId }).whereNull('deleted_at');
    if (ownerId) query.where('user_id', ownerId);
    const contact = await query.first();
    if (!contact) throw new HTTP404Error({ message: 'Contact not found in this company' });
    return contact;
  }
  async get(companyId: string, contactId: string, ownerId: string, before?: string) {
    const contact = await this.contact(companyId, contactId, ownerId);
    const recipient = this.recipient(contact);
    const preferences = await this.current(this.database, companyId, recipient);
    const events = this.database('whatsapp_preference_events').where({ company_id: companyId, recipient });
    if (before) {
      if (!/^\d+$/.test(before)) throw new HTTP400Error({ message: 'before must be an event ID' });
      events.where('id', '<', before);
    }
    const history = await events.orderBy('id', 'desc').limit(50);
    return { contact_id: contactId, company_id: companyId, recipient, preferences,
      events: history, next_cursor: history.length === 50 ? String(history[49].id) : null };
  }
  async recordStaff(companyId: string, contactId: string, ownerId: string, staffUserId: string, input: any) {
    if (!['all', 'marketing'].includes(input?.scope) || !['opted_in', 'opted_out'].includes(input?.status)) {
      throw new HTTP400Error({ message: 'scope must be all or marketing; status must be opted_in or opted_out' });
    }
    if (!staffPreferenceSources.includes(input.source)) throw new HTTP400Error({ message: 'Invalid staff preference source' });
    const evidence = input.evidence;
    if (!evidence || typeof evidence.reference !== 'string' || !evidence.reference.trim() || evidence.reference.length > 2000 ||
        typeof evidence.text !== 'string' || !evidence.text.trim() || evidence.text.length > 10000) {
      throw new HTTP400Error({ message: 'evidence.reference and evidence.text describing the consent or opt-out are required' });
    }
    const contact = await this.contact(companyId, contactId, ownerId);
    const recipient = this.recipient(contact);
    await this.database.transaction(async trx => {
      await this.lock(trx, companyId, recipient);
      await this.change(trx, contact, recipient, { scope: input.scope, status: input.status, source: input.source,
        evidence: { reference: evidence.reference.trim(), text: evidence.text.trim() }, staffUserId });
    });
    return this.get(companyId, contactId, ownerId);
  }

  /** Internal only: register the exact consent text on an already-sent request, never on an arbitrary YES. */
  async recordConsentRequest(companyId: string, contactId: string, requestWamid: string, scope: PreferenceScope, terms: string, expiresAt: Date) {
    if (!['all', 'marketing'].includes(scope) || !terms?.trim() || terms.length > 10000 ||
        !Number.isFinite(expiresAt?.getTime()) || expiresAt <= new Date()) throw new HTTP400Error({ message: 'Invalid consent request' });
    const contact = await this.contact(companyId, contactId);
    const recipient = this.recipient(contact);
    const message = await this.database('messages').where({ company_id: companyId, wamid: requestWamid, direction: 'outbound' }).first();
    const text = message?.content?.text?.body;
    if (!message || !['sent', 'delivered', 'read'].includes(message.status) ||
        String(message.to_phone).replace(/\D/g, '') !== recipient || typeof text !== 'string' || !text.includes(terms)) {
      throw new HTTP400Error({ message: 'Consent request must reference a sent message containing the agreed text for this recipient' });
    }
    return this.database('whatsapp_consent_requests').insert({ company_id: companyId, contact_id: contactId,
      phone_number_id: message.phone_number_id, recipient, request_wamid: requestWamid, scope, terms: terms.trim(), expires_at: expiresAt,
    }).returning('*');
  }

  /** Message storage, command handling, audit event and reply reservation commit atomically. */
  async persistIncoming(contact: any, payload: any, incoming: any) {
    if (!payload.wamid) throw new HTTP400Error({ message: 'Incoming WhatsApp message ID is required' });
    const recipient = this.recipient(contact);
    const seconds = Number(incoming?.timestamp);
    const receivedAt = Number.isFinite(seconds) && seconds > 0
      ? new Date(Math.min(seconds * 1000, Date.now())) : new Date();
    return this.database.transaction(async trx => {
      await this.lock(trx, contact.company_id, recipient);
      const [receipt] = await trx('whatsapp_inbound_receipts').insert({
        company_id: contact.company_id, contact_id: contact.id, phone_number_id: payload.phone_number_id,
        recipient, wamid: payload.wamid, received_at: receivedAt,
      }).onConflict(['company_id', 'wamid']).ignore().returning('*');
      if (!receipt) {
        const existing = await trx('whatsapp_inbound_receipts').where({ company_id: contact.company_id, wamid: payload.wamid }).first();
        const message = await trx('messages').where({ company_id: contact.company_id, wamid: payload.wamid }).first();
        return { message, receipt: existing, duplicate: true, handled: existing.handled };
      }
      const [inserted] = await trx('messages').insert({ ...payload, created_at: receivedAt,
        content: JSON.stringify(payload.content), context: JSON.stringify(payload.context ?? null),
      }).onConflict('wamid').ignore().returning('*');
      const message = inserted || await trx('messages').where({ company_id: contact.company_id, wamid: payload.wamid }).first();
      if (!message) throw new Error('Incoming message identity conflict');
      let command = preferenceCommand(incoming);
      let consent: any;
      if (!command && affirmativeConsentReply(incoming) && incoming?.context?.id) {
        consent = await trx('whatsapp_consent_requests').where({ company_id: contact.company_id, recipient,
          phone_number_id: payload.phone_number_id, request_wamid: incoming.context.id,
        }).whereNull('consumed_at').where('expires_at', '>', new Date()).forUpdate().first();
        if (consent) command = { action: 'START', scope: consent.scope, source: 'whatsapp_consent_reply' };
      }
      if (!command) return { message, receipt, duplicate: !inserted, handled: false };
      let reply: string;
      if (command.action === 'HELP') {
        reply = (process.env.WHATSAPP_SUPPORT_MESSAGE || 'For support, reply here with your question. Reply STOP to stop messages or START to opt back in.').slice(0, 1024);
      } else {
        await this.change(trx, contact, recipient, { scope: command.scope,
          status: command.action === 'STOP' ? 'opted_out' : 'opted_in', source: command.source,
          wamid: payload.wamid, occurredAt: receivedAt,
          evidence: { reference: payload.wamid, text: consent?.terms || `${command.action}: ${command.scope} WhatsApp business-initiated messages`,
            ...(consent ? { consent_request_id: consent.id, request_wamid: consent.request_wamid } : {}) },
        });
        if (consent) await trx('whatsapp_consent_requests').where({ id: consent.id }).update({ consumed_at: trx.fn.now() });
        reply = command.action === 'STOP'
          ? (command.scope === 'all' ? 'You have opted out of messages from this business. Reply START to opt back in.' : 'You have opted out of marketing messages from this business.')
          : (command.scope === 'all' ? 'You have opted back in to messages from this business. Reply STOP to opt out.' : 'You have opted in to marketing messages from this business. Reply STOP to opt out.');
      }
      const [updated] = await trx('whatsapp_inbound_receipts').where({ id: receipt.id }).update({
        handled: true, command: command.action, reply_text: reply, reply_status: 'pending',
      }).returning('*');
      return { message, receipt: updated, duplicate: !inserted, handled: true };
    });
  }

  async claimReply(receiptId: string) {
    const [receipt] = await this.database('whatsapp_inbound_receipts').where({ id: receiptId, reply_status: 'pending' })
      .update({ reply_status: 'sending', reply_token: randomUUID() }).returning('*');
    return receipt;
  }
  async finishReply(receiptId: string, wamid?: string, error?: string) {
    await this.database('whatsapp_inbound_receipts').where({ id: receiptId, reply_status: 'sending' })
      .update({ reply_status: error ? 'failed' : 'sent', reply_wamid: wamid ?? null, reply_error: error?.slice(0, 2000) ?? null });
  }

  private async assertAllowed(trx: Knex.Transaction, phone: any, payload: any, context: WhatsAppSendContext, recipient: string) {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    if (context.preferenceReply) {
      const receipt = await trx('whatsapp_inbound_receipts').where({ id: context.preferenceReply.receiptId,
        reply_token: context.preferenceReply.token, reply_status: 'sending', company_id: phone.company_id,
        phone_number_id: phone.id, recipient, handled: true,
      }).where('received_at', '>', since).first();
      if (receipt && payload.type === 'text' && payload.text?.body === receipt.reply_text && payload.context?.message_id === receipt.wamid) return;
      throw new WhatsAppSuppressedError('WHATSAPP_WINDOW_CLOSED', 'Preference confirmation does not match a current incoming command');
    }
    const preferences = await this.current(trx, phone.company_id, recipient);
    const statuses = Object.fromEntries(preferences.map(row => [row.scope, row.status]));
    let marketing = false;
    if (payload.type === 'template') {
      const template = await trx('templates').where({ company_id: phone.company_id, waba_id: phone.waba_id,
        name: payload.template?.name, language: payload.template?.language?.code,
      }).whereNull('deleted_at').first();
      // Unknown templates fail closed as marketing; callers cannot supply their own category.
      marketing = !template || !['UTILITY', 'AUTHENTICATION'].includes(String(template.category).toUpperCase());
    }
    const inboundQuery = trx('messages').where({ company_id: phone.company_id, phone_number_id: phone.id, direction: 'inbound' })
      .whereRaw("regexp_replace(from_phone, '[^0-9]', '', 'g') = ?", [recipient]).where('created_at', '>', since);
    const latestInbound = await inboundQuery.clone().orderBy('created_at', 'desc').first();
    let support = false;
    if (!context.businessInitiated && payload.type !== 'template' && payload.context?.message_id) {
      const request = await inboundQuery.clone().where('wamid', payload.context.message_id).first();
      const command = request && await trx('whatsapp_inbound_receipts').where({ company_id: phone.company_id, wamid: request.wamid, handled: true }).first();
      const stopped = preferences.find(row => row.scope === 'all' && row.status === 'opted_out');
      support = Boolean(request && !command && (!stopped || new Date(request.created_at) > new Date(stopped.updated_at)));
    }
    enforcePreferencePolicy(statuses, marketing, support);
    if (payload.type !== 'template' && !latestInbound) {
      throw new WhatsAppSuppressedError('WHATSAPP_WINDOW_CLOSED', 'A customer message within the last 24 hours is required for non-template replies');
    }
  }

  /** Final guard, shared by every Meta send. Same lock as STOP serializes changes with dispatch. */
  async guardSend<T>(phoneNumberId: string, payload: any, context: WhatsAppSendContext, send: () => Promise<T>): Promise<T> {
    const phone = await this.database('phone_numbers').where({ phone_number_id: phoneNumberId }).whereNull('deleted_at').first();
    if (!phone) throw new HTTP404Error({ message: 'WhatsApp business phone number not found' });
    const identity = parseWhatsAppPhone(payload.to);
    const recipient = identity.country_code + identity.phone_number;
    return this.database.transaction(async trx => {
      await this.lock(trx, phone.company_id, recipient);
      await this.assertAllowed(trx, phone, payload, context, recipient);
      return send();
    });
  }
}
export default new WhatsAppPreferenceService();
