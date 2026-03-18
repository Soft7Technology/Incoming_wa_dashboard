import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  return knex.schema.createTable('phone_numbers', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('company_id').notNullable().references('id').inTable('companies').onDelete('CASCADE');
    table.uuid('waba_id').notNullable().references('id').inTable('waba_accounts').onDelete('CASCADE');
    table.string('phone_number_id', 255).notNullable().unique(); // Meta Phone Number ID
    table.string('display_phone_number', 50).notNullable();
    table.string('verified_name', 255);
    table.string('code_verification_status', 50);
    table.string('quality_rating', 50); // GREEN, YELLOW, RED
    table.enum('status', ['active', 'inactive', 'pending']).defaultTo('active');
    table.integer('messaging_limit_tier').defaultTo(1); // 1, 2, 3, 4
    table.jsonb('capabilities'); // messaging, voice, etc.
    table.jsonb('meta_data');
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('updated_at').defaultTo(knex.fn.now());
    table.timestamp('deleted_at');

    table.index(['company_id']);
    table.index(['waba_id']);
    table.index(['phone_number_id']);
    table.index(['status']);
  });
}

export async function down(knex: Knex): Promise<void> {
  return knex.schema.dropTableIfExists('phone_numbers');
}
