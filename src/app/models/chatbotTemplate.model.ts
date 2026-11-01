import db from '@surefy/database';
import type { Knex } from 'knex';
import type { buildChatbotTemplate } from '../utils/chatbotTemplates';

export type ChatbotTemplateDefinition = NonNullable<ReturnType<typeof buildChatbotTemplate>>;

export class ChatbotTemplateModel {
  constructor(private database: Knex = db) {}

  async categories() {
    const rows: Array<{ id: string; name: string; template_count: string | number }> = await this.database('chatbot_template_categories as category')
      .join('chatbot_templates as template', 'template.category_id', 'category.id')
      .where('template.available', true).groupBy('category.id', 'category.name', 'category.sort_order')
      .select('category.id', 'category.name').count<any>('template.id as template_count').orderBy('category.sort_order');
    return rows.map(row => ({ ...row, template_count: Number(row.template_count) }));
  }

  async list(category?: string, search?: string) {
    const query = this.database('chatbot_templates').where({ available: true });
    if (category) query.where({ category_id: category });
    if (search) query.whereILike('name', `%${search.replace(/[\\%_]/g, '\\$&')}%`);
    return (await query.select('metadata').orderBy('name').orderBy('id')).map(row => row.metadata);
  }

  async detail(id: string): Promise<ChatbotTemplateDefinition | undefined> {
    const row = await this.database('chatbot_templates').where({ id, available: true })
      .first('metadata', 'nodes', 'edges');
    return row ? { ...row.metadata, nodes: row.nodes, edges: row.edges } : undefined;
  }
}

export default new ChatbotTemplateModel();
