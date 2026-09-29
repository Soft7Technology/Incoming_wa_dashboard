import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('templates', table => {
    table.dropUnique(['company_id', 'name', 'language']);
  });
  await knex.raw(`CREATE UNIQUE INDEX templates_waba_name_language_active_unique
    ON templates (company_id, waba_id, name, language) WHERE deleted_at IS NULL`);
}

export async function down(knex: Knex): Promise<void> {
  // Restoring the old constraint fails safely if multiple WABAs now share a name/language.
  await knex.schema.alterTable('templates', table => table.unique(['company_id', 'name', 'language']));
  await knex.raw('DROP INDEX templates_waba_name_language_active_unique');
}
