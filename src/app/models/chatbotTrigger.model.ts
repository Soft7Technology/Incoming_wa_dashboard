import { BaseModel } from '@surefy/models/base.model';

class ChatbotTriggerModel extends BaseModel {
  constructor() {
    super('chatbot_triggers');
  }

  async findConflicts({
    phoneNumberId,
    triggers,
    excludeChatBotId,
  }: {
    phoneNumberId: string;
    triggers: string[];
    excludeChatBotId?: string;
  }) {
    if (!triggers.length) {
      return [];
    }

    const normalizedTriggers = triggers.map((trigger) =>
      trigger.trim().toLowerCase()
    );

    const query = this.query()
      .select([
        'id',
        'phone_number_id',
        'chatbot_id',
        'trigger_word',
      ])
      .where('phone_number_id', phoneNumberId)
      .where('active', true)
      .whereRaw(
        'LOWER(TRIM(trigger_word)) IN (?)',
        [normalizedTriggers]
      );

    if (excludeChatBotId) {
      query.whereNot('chatbot_id', excludeChatBotId);
    }

    return await query;
  }
  
  

  async deleteByChatBot(chatBotId: string) {
    return this.query()
      .where("chatbot_id", chatBotId)
      .delete();
  }

  async createMany(rows: any[]) {
    console.log("Rows",rows)
    return this.query().insert(rows);
  }


  async updateByChatBot(
  chatBotId: string,
  data: Record<string, any>
) {
  return this.query()
    .where("chatbot_id", chatBotId)
    .update(data);
}

async getActiveTriggers(phoneNumberId: string) {
  const triggers = await this.query()
    .where({
      phone_number_id: phoneNumberId,
      active: true,
    })
    .select("trigger_word");

  return triggers.map(
    (trigger: any) => trigger.trigger_word
  );
}
}

export default new ChatbotTriggerModel();