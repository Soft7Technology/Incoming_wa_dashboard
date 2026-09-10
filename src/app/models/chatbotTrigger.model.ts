import { BaseModel } from '@surefy/models/base.model';

class ChatbotTriggerModel extends BaseModel {
  constructor() {
    super('chatbot_triggers');
  }


  async findRuntimeMapping(phoneNumberId: string, chatbotId?: string, text?: string) {
    const query = this.query().where({ phone_number_id: phoneNumberId, active: true });
    if (chatbotId) query.where({ chatbot_id: chatbotId });
    if (text !== undefined) {
      const normalized = text.trim().toLowerCase().replace(/\s+/g, ' ');
      if (!normalized) return null;
      query.whereRaw('LOWER(TRIM(trigger_word)) = ?', [normalized]);
    }
    return query.orderBy('created_at').orderBy('id').first();
  }

  async insertMany(records: any[]) {
    if (!records.length) {
      return [];
    }

    return this.query().insert(records).returning("*");
  }


  async findConflictingTriggers({
    phoneNumberId,
    triggerWords,
    excludeChatBotId,
  }: {
    phoneNumberId: string;
    triggerWords: string[];
    excludeChatBotId?: string;
  }) {
    const query = this.query()
      .where("phone_number_id", phoneNumberId)
      .whereIn("trigger_word", triggerWords);

    if (excludeChatBotId) {
      query.whereNot("chatbot_id", excludeChatBotId);
    }

    return query;
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
    console.log("Rows", rows)
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