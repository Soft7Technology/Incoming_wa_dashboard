import { randomUUID } from 'crypto';
import db from '@surefy/database';
import { CustomError } from '@surefy/exceptions/CustomError';
import type { MessengerScope } from './facebookConversation.model';

export type IncomingMessengerMessage = {
  pageId: string;
  senderId: string;
  messageId: string;
  text: string;
  eventAt: Date;
  payload: Record<string, unknown>;
  sharedEmail?: { email: string; source: 'quick_reply' | 'message_text' };
};

class FacebookMessageModel {
  async reserveReply(conversationId: string, scope: MessengerScope, text: string, requestId: string) {
    return db.transaction(async (trx) => {
      const context = await trx('facebook_conversations as conversation')
        .join('facebook_pages as page', 'page.id', 'conversation.page_connection_id')
        .where({ 'conversation.id': conversationId, 'page.company_id': scope.companyId, 'page.owner_id': scope.ownerId })
        .first('conversation.page_connection_id');
      if (!context) throw new CustomError('Messenger conversation not found.', 404);
      // Use the same lock order as webhook ingestion: Page, then conversation.
      const page = await trx('facebook_pages').where({
        id: context.page_connection_id, company_id: scope.companyId, owner_id: scope.ownerId,
      }).forUpdate().first();
      const conversation = await trx('facebook_conversations')
        .where({ id: conversationId, page_connection_id: context.page_connection_id }).forUpdate().first();
      if (!page || !conversation) throw new CustomError('Messenger conversation not found.', 404);
      const existing = await trx('facebook_messages')
        .where({ conversation_id: conversationId, client_request_id: requestId }).first();
      if (existing) {
        if (existing.text !== text) throw new CustomError('This client_request_id was already used for different text.', 409);
        if (['sent', 'delivered', 'read'].includes(existing.status)) return { message: existing, replay: true };
        if (existing.status !== 'failed' || existing.send_outcome !== 'rejected') {
          throw new CustomError('This message is pending or its delivery is uncertain. Check the Page inbox before sending again.', 409);
        }
      }
      if (page.status !== 'connected' || !page.token_ciphertext) {
        throw new CustomError('Reconnect the Facebook Page before sending messages.', 409);
      }
      const now = new Date();
      for (const expiry of [page.token_expires_at, page.data_access_expires_at]) {
        if (expiry && new Date(expiry).getTime() <= now.getTime()) {
          throw new CustomError('Facebook Page access expired. Reconnect the Page.', 409);
        }
      }
      const customerAt = new Date(conversation.last_customer_message_at).getTime();
      if (!conversation.last_customer_message_at || !Number.isFinite(customerAt) ||
          customerAt > now.getTime() || now.getTime() - customerAt >= 24 * 60 * 60 * 1000) {
        throw new CustomError('The 24-hour reply window has closed. Wait for the customer to message your Page again.', 409);
      }
      const values = { status: 'sending', send_outcome: null, error: null, event_at: now };
      const [message] = existing
        ? await trx('facebook_messages').where({ id: existing.id }).update(values).returning('*')
        : await trx('facebook_messages').insert({
          ...values, id: randomUUID(), conversation_id: conversationId, page_connection_id: page.id,
          client_request_id: requestId, agent_id: scope.userId, direction: 'outbound', text,
        }).returning('*');
      return { message, replay: false, pageId: page.page_id as string,
        psid: conversation.psid as string, ciphertext: page.token_ciphertext as string };
    });
  }

  async completeReply(messageId: string, metaMessageId: string) {
    return db.transaction(async (trx) => {
      const [message] = await trx('facebook_messages').where({ id: messageId, status: 'sending' })
        .update({ meta_message_id: metaMessageId, status: 'sent', send_outcome: 'confirmed', error: null })
        .returning('*');
      if (!message) throw new CustomError('The sent message could not be recorded.', 503);
      await trx('facebook_conversations').where({ id: message.conversation_id })
        .update({ last_message_at: trx.raw('GREATEST(??, ?::timestamptz)', ['last_message_at', message.event_at]) });
      return message;
    });
  }

  async failReply(messageId: string, error: string, uncertain: boolean) {
    await db('facebook_messages').where({ id: messageId, status: 'sending' })
      .update({ status: 'failed', error, send_outcome: uncertain ? 'unknown' : 'rejected' });
  }

  async saveIncoming(input: IncomingMessengerMessage): Promise<void> {
    await db.transaction(async (trx) => {
      // Page ID determines the tenant; never accept company_id
      // from webhook payloads.
      const page = await trx('facebook_pages')
        .where({ page_id: input.pageId })
        .select('id', 'status')
        .forUpdate()
        .first();

      if (!page) return;

      if (page.status === 'pending_subscription') {
        throw new CustomError(
          'Messenger Page subscription is pending. Retry delivery.',
          503,
        );
      }

      if (page.status !== 'connected') return;

      // The Page lock serializes webhook writes for this Page.
      const existing = await trx('facebook_messages')
        .where({
          page_connection_id: page.id,
          meta_message_id: input.messageId,
        })
        .first('id');

      if (existing) return;

      await trx('facebook_conversations')
        .insert({
          page_connection_id: page.id,
          psid: input.senderId,
          last_message_at: input.eventAt,
          last_customer_message_at: input.eventAt,
        })
        .onConflict(['page_connection_id', 'psid'])
        .ignore();

      const conversation = await trx('facebook_conversations')
        .where({
          page_connection_id: page.id,
          psid: input.senderId,
        })
        .first('id');

      if (!conversation) {
        throw new Error('Messenger conversation could not be created.');
      }

      const [inserted] = await trx('facebook_messages')
        .insert({
          id: randomUUID(),
          conversation_id: conversation.id,
          page_connection_id: page.id,
          meta_message_id: input.messageId,
          direction: 'inbound',
          text: input.text,
          status: 'received',
          event_at: input.eventAt,
          payload: JSON.stringify(input.payload),
        })
        .onConflict(['page_connection_id', 'meta_message_id'])
        .ignore()
        .returning('id');

      if (!inserted) return;

      if (input.sharedEmail) {
        // Duplicate/older webhook deliveries must not replace a newer address.
        // This is a customer-provided contact address, not a verified identity.
        await trx('facebook_conversations').where({ id: conversation.id })
          .where(function () {
            this.whereNull('participant_email_at').orWhere('participant_email_at', '<', input.eventAt);
          })
          .update({ participant_email: input.sharedEmail.email,
            participant_email_source: input.sharedEmail.source, participant_email_at: input.eventAt });
      }

      // Older events must not move conversation timestamps backwards.
      await trx('facebook_conversations')
        .where({ id: conversation.id })
        .update({
          last_message_at: trx.raw(
            'GREATEST(??, ?::timestamptz)',
            ['last_message_at', input.eventAt],
          ),
          last_customer_message_at: trx.raw(
            'GREATEST(??, ?::timestamptz)',
            ['last_customer_message_at', input.eventAt],
          ),
        });
    });
  }
}

export default new FacebookMessageModel();
