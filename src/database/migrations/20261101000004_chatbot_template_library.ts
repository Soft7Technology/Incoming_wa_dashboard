import type { Knex } from 'knex';
import templates from '../data/chatbotTemplateLibrary.v1';

export async function up(db: Knex): Promise<void> {
  await db.schema.createTable('chatbot_template_categories', t => {
    t.string('id', 80).primary();
    t.string('name', 120).notNullable();
    t.integer('sort_order').notNullable().defaultTo(0);
  });
  await db.schema.createTable('chatbot_templates', t => {
    t.string('id', 100).primary();
    t.string('category_id', 80).notNullable().references('id').inTable('chatbot_template_categories');
    t.string('name', 120).notNullable();
    t.integer('version').notNullable();
    t.boolean('available').notNullable().defaultTo(true);
    t.jsonb('metadata').notNullable();
    t.jsonb('nodes').notNullable();
    t.jsonb('edges').notNullable();
    t.timestamps(true, true);
    t.index(['category_id', 'available']);
  });
  await db.schema.createTable('chatbot_template_installs', t => {
    t.uuid('chatbot_id').primary().references('id').inTable('chat_bot').onDelete('CASCADE');
    t.string('template_id', 100).notNullable().references('id').inTable('chatbot_templates');
    t.integer('template_version').notNullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(db.fn.now());
    t.index('template_id');
  });
  const categories = [...new Map(templates.map(t => [t.category, t.category_name])).entries()];
  await db('chatbot_template_categories').insert(categories.map(([id, name], sort_order) => ({ id, name, sort_order })));
  await db('chatbot_templates').insert(templates.map(({ nodes, edges, ...metadata }) => ({
    id: metadata.id, category_id: metadata.category, name: metadata.name, version: metadata.version,
    metadata: JSON.stringify(metadata), nodes: JSON.stringify(nodes), edges: JSON.stringify(edges),
  })));
}

export async function down(db: Knex): Promise<void> {
  await db.schema.dropTable('chatbot_template_installs');
  await db.schema.dropTable('chatbot_templates');
  await db.schema.dropTable('chatbot_template_categories');
}
