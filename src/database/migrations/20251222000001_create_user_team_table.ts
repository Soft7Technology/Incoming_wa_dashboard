import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  const hasTable = await knex.schema.hasTable('user_team');
  if (hasTable) return;

  return knex.schema.createTable('user_team', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('company_id').references('id').inTable('companies').onDelete('CASCADE');
    table.uuid('invite_sent_by').references('id').inTable('users').onDelete('CASCADE');
    table.string('name', 255);
    table.string('email', 255).notNullable();
    table.string('phone_number', 50);
    table.string('role', 50).notNullable();
    table.jsonb('permission').defaultTo('{}');
    table.string('invite_token', 255).unique();
    table.enum('invite_status', ['sent', 'accepted', 'expired']).defaultTo('sent');
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('updated_at').defaultTo(knex.fn.now());

    // Indexes
    table.index(['email']);
    table.index(['company_id']);
    table.index(['invite_sent_by']);
    table.index(['invite_token']);
    table.index(['invite_status']);
  });
}

export async function down(knex: Knex): Promise<void> {
  return knex.schema.dropTableIfExists('user_team');
}
