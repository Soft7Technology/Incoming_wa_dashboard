import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  return knex.schema.alterTable('campaigns', (table) => {
    // Remove recipients JSONB, replace with filter-based approach
    table.dropColumn('recipients');

    // Add filter-based contact selection
    table.jsonb('contact_filters'); // { tag_ids: [], list_ids: [], exclude_invalid: true, custom_filters: {} }
    table.jsonb('media_uploads'); // Array of media files uploaded for template
    table.jsonb('parameter_mapping'); // Template parameter to contact attribute mapping
    table.integer('invalid_numbers_count').defaultTo(0);
  });
}

export async function down(knex: Knex): Promise<void> {
  return knex.schema.alterTable('campaigns', (table) => {
    table.jsonb('recipients');
    table.dropColumn('contact_filters');
    table.dropColumn('media_uploads');
    table.dropColumn('parameter_mapping');
    table.dropColumn('invalid_numbers_count');
  });
}
