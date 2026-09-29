import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  return knex.schema.createTable('users', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('company_id').references('id').inTable('companies').onDelete('CASCADE');
    table.string('name', 255).notNullable();
    table.string('email', 255).unique();
    table.string('phone', 50).unique();
    table.string('password', 255).notNullable(); // Hashed password
    table.enum('role', ['superadmin', 'admin', 'company']).notNullable().defaultTo('company');
    table.enum('status', ['active', 'inactive', 'suspended']).defaultTo('active');
    table.string('avatar', 500);
    table.jsonb('permissions'); // Additional granular permissions
    table.jsonb('settings'); // User preferences
    table.timestamp('last_login_at');
    table.string('last_login_ip', 50);
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('updated_at').defaultTo(knex.fn.now());
    table.timestamp('deleted_at');

    // Indexes
    table.index(['email']);
    table.index(['phone']);
    table.index(['company_id']);
    table.index(['role']);
    table.index(['status']);
  });
}

export async function down(knex: Knex): Promise<void> {
  return knex.schema.dropTableIfExists('users');
}
