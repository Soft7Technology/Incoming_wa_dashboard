import type { Knex } from 'knex';
import template from '../data/realEstateLeadManagement.v1';

export async function up(db: Knex): Promise<void> {
  await db('chatbot_template_categories').insert({ id: 'real-estate', name: 'Real Estate', sort_order: 0 })
    .onConflict('id').ignore();
  const { nodes, edges, ...metadata } = template;
  await db('chatbot_templates').insert({ id: template.id, category_id: template.category,
    name: template.name, version: template.version, available: true,
    metadata: JSON.stringify(metadata), nodes: JSON.stringify(nodes), edges: JSON.stringify(edges),
  }).onConflict('id').merge({ available: true });
}

export async function down(db: Knex): Promise<void> {
  // Keep provenance and tenant-owned copies intact when reverting this release.
  await db('chatbot_templates').where({ id: template.id, version: template.version }).update({ available: false });
}
