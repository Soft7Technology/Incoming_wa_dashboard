import { BaseModel } from '@surefy/models/base.model';
import { AIAssistant } from '../interfaces/aiAssistant.interface';
import db from '@surefy/database';

class AIAssistantModel extends BaseModel {
  constructor() {
    super('ai_assistants');
  }

  async createAssistant(data: AIAssistant): Promise<AIAssistant> {
    const [result] = await this.query().insert(data).returning('*');
    return result;
  }

  async findById(id: number | string): Promise<AIAssistant | undefined> {
    return this.query().where({ id }).first();
  }

  // A flow can use only an active assistant owned by its receiving-number account.
  async findActiveOwned(id: string, userId: string) {
    // Text comparison supports both legacy numeric IDs and UUID-based deployments.
    return this.query().where({ user_id: userId, status: 'ACTIVE' })
      .whereRaw('id::text = ?', [String(id)]).first();
  }

  async findByUserId(userId: string): Promise<any[]> {
    return this.query().where({ user_id: userId });
  }
 

  async deleteAssistant(id: number | string): Promise<number> {
    return this.query().where({ id }).del();
  }


}

export default new AIAssistantModel();
