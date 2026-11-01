import { CustomError } from '@surefy/exceptions/CustomError';
import facebookConversationModel, { MessengerScope } from '../models/facebookConversation.model';
import facebookMessageModel from '../models/facebookMessage.model';
import facebookMessengerGraphService, { MessengerSendError } from './facebookMessengerGraph.service';

type Pagination = { page: number; limit: number };

class FacebookMessagingService {
  private assertAccess(scope: MessengerScope) {
    if (!scope.companyId || !scope.ownerId || !scope.userId || scope.userId !== scope.ownerId) {
      throw new CustomError('Only the account owner can access this Messenger inbox.', 403);
    }
  }

  async listConversations(pageConnectionId: string, scope: MessengerScope, pagination: Pagination) {
    this.assertAccess(scope);
    if (!(await facebookConversationModel.findPage(pageConnectionId, scope))) {
      throw new CustomError('Facebook Page connection not found.', 404);
    }
    const { page, limit } = pagination;
    const rows = await facebookConversationModel.list(pageConnectionId, scope, limit, (page - 1) * limit);
    // Bound external requests and cache failed lookups; profile access is optional.
    await Promise.all(rows.slice(0, limit).filter(row => !row.participant_name).slice(0, 3).map(async row => {
      try {
        const context = await facebookConversationModel.claimProfile(row.id, scope);
        if (!context) return;
        const name = await facebookMessengerGraphService.getName(context.psid, context.token_ciphertext);
        if (name && await facebookConversationModel.saveName(context, scope, name)) row.participant_name = name;
      } catch {
        // Do not expose Graph errors or tokens, or fail the inbox for an unavailable profile.
      }
    }));
    return { conversations: rows.slice(0, limit), pagination: { page, limit, has_more: rows.length > limit } };
  }

  async listMessages(conversationId: string, scope: MessengerScope, pagination: Pagination) {
    this.assertAccess(scope);
    if (!(await facebookConversationModel.findConversation(conversationId, scope))) {
      throw new CustomError('Messenger conversation not found.', 404);
    }
    const { page, limit } = pagination;
    const rows = await facebookConversationModel.listMessages(conversationId, scope, limit, (page - 1) * limit);
    return { messages: rows.slice(0, limit).reverse(), pagination: { page, limit, has_more: rows.length > limit } };
  }

  async sendMessage(conversationId: string, scope: MessengerScope, text: string, requestId: string) {
    this.assertAccess(scope);
    const reservation = await facebookMessageModel.reserveReply(conversationId, scope, text, requestId);
    let message = reservation.message;
    if (!reservation.replay) {
      let metaId: string;
      try {
        metaId = await facebookMessengerGraphService.sendText(
          reservation.pageId!, reservation.psid!, reservation.ciphertext!, text,
        );
      } catch (error) {
        const safe = error instanceof MessengerSendError ? error : new MessengerSendError(
          'Delivery could not be confirmed. Check the Page inbox before sending again.', 502, true,
        );
        try { await facebookMessageModel.failReply(message.id, safe.message, safe.uncertain); } catch {
          // Keep the durable sending reservation blocked if recording the failure fails.
        }
        throw safe;
      }
      try {
        message = await facebookMessageModel.completeReply(message.id, metaId);
      } catch {
        // Meta has accepted this message: never release it for an automatic retry.
        throw new CustomError('Meta accepted the message, but saving its confirmation failed. Check the Page inbox before sending again.', 503);
      }
    }
    return {
      id: message.id, conversation_id: message.conversation_id, page_connection_id: message.page_connection_id,
      client_request_id: message.client_request_id, meta_message_id: message.meta_message_id,
      direction: message.direction, text: message.text, status: message.status, error: message.error,
      event_at: message.event_at, created_at: message.event_at,
    };
  }
}

export default new FacebookMessagingService();
