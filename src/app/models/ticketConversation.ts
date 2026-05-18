import { BaseModel } from '@surefy/models/base.model';

class conversationTicketModel extends BaseModel {
  constructor() {
    super('ticket_conversation');
  }

  async findByTicketId(ticketId:string){
    const conversation = await this.findAll({ticket_id:ticketId})
    return conversation
  }

  async findConversationByTicketId(conversationId:string){
    const conversation = await this.query().where({ticket_id:conversationId}).first()
    return conversation
  }

  async forwardTicketConversations(ticketId:string,superAdminId:string){
    return await this.query().where({ticket_id:ticketId,forward_superadmin:superAdminId})
  }
}

export default new conversationTicketModel()