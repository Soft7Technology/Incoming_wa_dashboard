import { BaseModel } from '@surefy/models/base.model';
import { chatBot } from '../interfaces/chatbot.interface';

class chatBotNodeModel extends BaseModel {
  constructor() {
    super('chat_bot_node');
  }

  async createChatBot(data: chatBot) {
    return this.query().insert(data).returning('*');
  }

  async findByChatBotId(id: string | number): Promise<any> {
    return this.query().where({ chatBotId: id })
  }

  async createNodes(data: any[]) {
    return this.query().insert(data).returning('*'); // ✅
  }

  async deleteChatBotNode(chatBotId: string | number) {
    return this.query().where({ chatBotId }).delete();
  }
}

export default new chatBotNodeModel();
