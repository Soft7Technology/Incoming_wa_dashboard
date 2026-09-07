import { BaseModel } from '@surefy/models/base.model';
import { chatBot } from '../interfaces/chatbot.interface';

class chatBotModel extends BaseModel {
    constructor() {
        super("chat_bot")
    }

    async createChatBot(data: chatBot) {
        return this.query().insert(data).returning('*');
    }

    async findById(id: string | number): Promise<any> {
        return this.query().where({ id }).first()
    }

    async findByUserId(userId: string | number): Promise<any> {
        return this.query().where({ user_id: userId })
    }

    async getPublishedBotByUser(userId: string) {
        return this.query().where({ user_id: userId, status: 'published', published: true }).first()
    }

    async getPublishedBotByPhoneNumber(
        phoneNumberId: string,
        chatBotId?: string
    ) {
        const query = this.query()
            .select("chat_bot.*")
            .join(
                "chatbot_triggers",
                "chatbot_triggers.chatbot_id",
                "chat_bot.id"
            )
            .where(
                "chatbot_triggers.phone_number_id",
                phoneNumberId
            )
            .where("chat_bot.published", true);

        if (chatBotId) {
            query.whereNot("chat_bot.id", chatBotId);
        }

        return query.first();
    }


}

export default new chatBotModel();