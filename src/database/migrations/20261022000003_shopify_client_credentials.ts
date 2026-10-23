import { Knex } from 'knex';

export async function up(db: Knex) {
  await db.schema.createTable('shopify_app_credentials', table => {
    table.uuid('connection_id').primary().references('id').inTable('shopify_connections').onDelete('CASCADE');
    table.uuid('company_id').notNullable().references('id').inTable('companies').onDelete('CASCADE');
    table.uuid('owner_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    table.string('client_id', 255).notNullable();
    table.text('client_secret_ciphertext').notNullable();
    table.timestamps(true, true);
    table.index(['company_id', 'owner_id']);
  });
}

export async function down(db: Knex) {
  await db.schema.dropTableIfExists('shopify_app_credentials');
}
