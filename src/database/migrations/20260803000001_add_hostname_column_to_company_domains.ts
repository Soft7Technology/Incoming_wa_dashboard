import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  const hasHostname = await knex.schema.hasColumn('company_domains', 'hostname');
  if (!hasHostname) {
    await knex.schema.alterTable('company_domains', (table) => {
      table.string('hostname').nullable();
    });
  }

  const hasDomainName = await knex.schema.hasColumn('company_domains', 'domain_name');
  if (hasDomainName) {
    await knex.raw('UPDATE company_domains SET hostname = domain_name WHERE hostname IS NULL AND domain_name IS NOT NULL');
  }
}

export async function down(knex: Knex): Promise<void> {
  const hasHostname = await knex.schema.hasColumn('company_domains', 'hostname');
  if (hasHostname) {
    await knex.schema.alterTable('company_domains', (table) => {
      table.dropColumn('hostname');
    });
  }
}
