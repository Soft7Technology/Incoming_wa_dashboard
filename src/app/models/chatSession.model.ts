import { BaseModel } from '@surefy/models/base.model';

class chatSessionModel extends BaseModel {
    constructor() {
        super("chat_sessions")
    }

    async createChatBot(data: any) {
        return this.query().insert(data).returning('*');
    }

    async findById(id: string | number): Promise<any> {
        return this.query().where({ id }).first()
    }

    async findByPhoneandBot(phoneNumber: string, botId: any) {
        return this.query().where({ phone_number: phoneNumber, chatbot_id: botId, active: true }).first()
    }

    async findByPhoneNumber(phone_number: any) {
        return this.query().where({ phone_number: phone_number, active: true }).first()
    }

    async deactivateSessions(existing_session: any) {
        return this.query().update(existing_session.id, { active: false })
    }

    async findActiveSession({
        phoneNumber,
        chatbotId,
        phoneNumberId,
    }: {
        phoneNumber: string;
        chatbotId: string;
        phoneNumberId: string;
    }) {
        return await this.query()
            .where({
                phone_number: phoneNumber,
                chatbot_id: chatbotId,
                phoneNumberId,
                active: true,
            })
            .first();
    }

    async deactivateActiveSession({
  phoneNumber,
  chatbotId,
  phoneNumberId,
}: {
  phoneNumber: string;
  chatbotId: string;
  phoneNumberId: string;
}) {
  return this.query()
    .where({
      phone_number: phoneNumber,
      chatbot_id: chatbotId,
      phoneNumberId,
      active: true,
    })
    .update({
      active: false,
      current_node_id: null,
      completed_at: new Date(),
      updated_at: new Date(),
    });
}

}

export default new chatSessionModel();