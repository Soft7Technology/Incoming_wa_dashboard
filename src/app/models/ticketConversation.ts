import { BaseModel } from '@surefy/models/base.model';

class conversationTicketModel extends BaseModel {
  constructor() {
    super('ticket_conversation');
  }

  async findByTicketId(ticketId:string){
    const conversation = await this.query()
      .select('ticket_conversation.*', 'users.role as sender_role')
      .leftJoin('users', 'ticket_conversation.user_id', 'users.id')
      .where({ 'ticket_conversation.ticket_id': ticketId })
      .orderBy('ticket_conversation.created_at', 'asc');
    return conversation;
  }

  async findConversationByTicketId(conversationId:string){
    const conversation = await this.query()
      .where({ ticket_id: conversationId })
      .orderBy('created_at', 'asc')
      .first();
    return conversation;
  }

  async forwardTicketConversations(ticketId:string,superAdminId:string){
    return await this.query()
      .select('ticket_conversation.*', 'users.role as sender_role')
      .leftJoin('users', 'ticket_conversation.user_id', 'users.id')
      .where({ 
        'ticket_conversation.ticket_id': ticketId, 
        'ticket_conversation.forward_superadmin': superAdminId 
      })
      .orderBy('ticket_conversation.created_at', 'asc');
  }
}

export default new conversationTicketModel()