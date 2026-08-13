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

  async findByUserId(userId: string): Promise<AIAssistant[]> {
    return this.query().where({ user_id: userId });
  }
 
  async updateAssistant(id: number | string, data: Partial<AIAssistant>): Promise<AIAssistant> {
    const [result] = await this.query().where({ id }).update(data).returning('*');
    return result;
  }

  async deleteAssistant(id: number | string): Promise<number> {
    return this.query().where({ id }).del();
  }

  // --------------------------------------------------
  // Knowledge Base Files Management
  // --------------------------------------------------

  async insertKnowledgeFile(payload: {
    ai_assistant_id: number;
    file_name: string;
    file_type: string;
    file_path: string;
    extracted_text: string | null;
  }) {
    const [id] = await db('ai_knowledge_files').insert(payload);
    return id;
  }

  async getKnowledgeFilesByAssistantId(ai_assistant_id: string | number) {
    return db('ai_knowledge_files').where({ ai_assistant_id });
  }

  async deleteKnowledgeFile(id: string | number) {
    return db('ai_knowledge_files').where({ id }).del();
  }
}

export default new AIAssistantModel();
