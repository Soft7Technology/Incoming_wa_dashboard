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
}

export default new conversationTicketModel()