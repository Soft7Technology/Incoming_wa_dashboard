import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('reminders', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('company_id').notNullable();
    t.uuid('user_id').notNullable();
    t.uuid('contact_id').notNullable().references('id').inTable('contacts');
    t.uuid('phone_number_id').notNullable().references('id').inTable('phone_numbers');
    t.uuid('template_id').notNullable().references('id').inTable('templates');
    t.string('name', 255).notNullable();
    t.string('frequency', 10).notNullable();
    t.string('timezone', 100).notNullable();
    t.string('local_datetime', 19).notNullable();
    t.jsonb('variables').notNullable();
    t.string('status', 20).notNullable().defaultTo('upcoming');
    t.uuid('last_attempt_id');
    t.timestamp('next_send_at', { useTz: true }).nullable();
    t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).defaultTo(knex.fn.now());
    t.index(['status', 'next_send_at']);
    t.index(['company_id', 'user_id', 'created_at']);
  });
  await knex.schema.createTable('reminder_attempts', (t) => {
    t.uuid('id').primary();
    t.uuid('reminder_id').notNullable().references('id').inTable('reminders');
    t.timestamp('scheduled_at', { useTz: true }).notNullable();
    t.timestamp('attempted_at', { useTz: true }).notNullable();
    t.timestamp('finished_at', { useTz: true });
    t.jsonb('snapshot').notNullable();
    t.string('status', 20).notNullable();
    t.string('wamid', 255).index();
    t.text('failure_reason');
    t.unique(['reminder_id', 'scheduled_at']);
  });
  // Store callbacks independently: they can arrive before sendMessage returns.
  await knex.schema.createTable('reminder_delivery_events', (t) => {
    t.bigIncrements('id');
    t.string('wamid', 255).notNullable();
    t.string('status', 30).notNullable();
    t.string('meta_timestamp', 30).notNullable();
    t.jsonb('error');
    t.timestamp('received_at', { useTz: true }).defaultTo(knex.fn.now());
    t.unique(['wamid', 'status', 'meta_timestamp']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable('reminder_delivery_events');
  await knex.schema.dropTable('reminder_attempts');
  await knex.schema.dropTable('reminders');
}
