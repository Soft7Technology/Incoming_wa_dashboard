import db from '@surefy/database';

export type MessengerScope = {
  companyId: string;
  ownerId: string;
  userId: string;
};

class FacebookConversationModel {
  findPage(pageConnectionId: string, scope: MessengerScope) {
    return db('facebook_pages')
      .where({ id: pageConnectionId, company_id: scope.companyId, owner_id: scope.ownerId })
      .first('id');
  }

  private scopedConversations(scope: MessengerScope) {
    return db('facebook_conversations as conversation')
      .join('facebook_pages as page', 'page.id', 'conversation.page_connection_id')
      .where({ 'page.company_id': scope.companyId, 'page.owner_id': scope.ownerId });
  }

  findConversation(conversationId: string, scope: MessengerScope) {
    return this.scopedConversations(scope)
      .where('conversation.id', conversationId)
      .first('conversation.id');
  }

  async claimProfile(conversationId: string, scope: MessengerScope) {
    const context = await this.scopedConversations(scope)
      .where({ 'conversation.id': conversationId, 'page.status': 'connected' })
      .first('conversation.id', 'conversation.psid', 'conversation.page_connection_id', 'page.token_ciphertext');
    if (!context?.token_ciphertext) return null;
    const [claimed] = await db('facebook_conversations')
      .where({ id: conversationId, page_connection_id: context.page_connection_id })
      .whereNull('participant_name')
      .where(function () {
        this.whereNull('profile_checked_at').orWhere('profile_checked_at', '<', new Date(Date.now() - 3600000));
      })
      .update({ profile_checked_at: new Date() }).returning('id');
    return claimed ? context : null;
  }

  async saveName(context: { id: string; page_connection_id: string; token_ciphertext: string }, scope: MessengerScope, name: string) {
    return db('facebook_conversations')
      .where({ id: context.id, page_connection_id: context.page_connection_id })
      .whereExists(db('facebook_pages').select('id').where({
        id: context.page_connection_id, company_id: scope.companyId, owner_id: scope.ownerId,
        status: 'connected', token_ciphertext: context.token_ciphertext,
      }))
      .update({ participant_name: name });
  }

  list(pageConnectionId: string, scope: MessengerScope, limit: number, offset: number) {
    const lastMessage = db('facebook_messages as message')
      .whereRaw('?? = ??', ['message.conversation_id', 'conversation.id'])
      .whereRaw('?? = ??', ['message.page_connection_id', 'conversation.page_connection_id'])
      .select('message.text')
      .orderBy('message.event_at', 'desc')
      .orderBy('message.id', 'desc')
      .limit(1);

    return this.scopedConversations(scope)
      .where('conversation.page_connection_id', pageConnectionId)
      .select(
        'conversation.id', 'conversation.page_connection_id', 'conversation.psid', 'conversation.participant_name',
        'conversation.participant_email', 'conversation.participant_email_source', 'conversation.participant_email_at',
        'conversation.last_message_at', 'conversation.last_customer_message_at',
        lastMessage.as('last_message_text'),
      )
      .orderBy('conversation.last_message_at', 'desc')
      .orderBy('conversation.id', 'desc')
      .limit(limit + 1)
      .offset(offset);
  }

  listMessages(conversationId: string, scope: MessengerScope, limit: number, offset: number) {
    return this.scopedConversations(scope)
      .join('facebook_messages as message', function () {
        this.on('message.conversation_id', '=', 'conversation.id')
          .andOn('message.page_connection_id', '=', 'conversation.page_connection_id');
      })
      .where('conversation.id', conversationId)
      .select(
        'message.id', 'message.conversation_id', 'message.page_connection_id',
        'message.client_request_id', 'message.meta_message_id', 'message.direction',
        'message.text', 'message.status', 'message.error', 'message.payload',
        'message.event_at',
        // The inbox sorts created_at: use the actual message time, not import time.
        'message.event_at as created_at', 'message.created_at as stored_at',
      )
      .orderBy('message.event_at', 'desc')
      .orderBy('message.id', 'desc')
      .limit(limit + 1)
      .offset(offset);
  }
}

export default new FacebookConversationModel();
