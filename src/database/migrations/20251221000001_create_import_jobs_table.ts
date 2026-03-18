import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('import_jobs', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('company_id').notNullable().references('id').inTable('companies').onDelete('CASCADE');
    table.uuid('list_id').nullable().references('id').inTable('contact_lists').onDelete('SET NULL');

    table.string('job_type').notNullable().defaultTo('contact_import'); // For future: template_import, etc.
    table.string('status').notNullable().defaultTo('queued'); // queued, processing, completed, failed, cancelled

    table.string('file_name').nullable();
    table.string('file_path').nullable();
    table.jsonb('file_headers').nullable();

    table.integer('total_rows').defaultTo(0);
    table.integer('processed_rows').defaultTo(0);
    table.integer('successful_rows').defaultTo(0);
    table.integer('failed_rows').defaultTo(0);
    table.integer('skipped_rows').defaultTo(0);

    table.integer('progress_percentage').defaultTo(0);

    table.jsonb('import_options').nullable(); // Store column mappings, tag_ids, etc.
    table.jsonb('errors').nullable(); // Array of error objects
    table.jsonb('result').nullable(); // Final result data

    table.timestamp('started_at').nullable();
    table.timestamp('completed_at').nullable();
    table.timestamp('failed_at').nullable();

    table.text('error_message').nullable();
    table.text('error_stack').nullable();

    table.timestamps(true, true);
    table.timestamp('deleted_at').nullable();

    // Indexes
    table.index('company_id');
    table.index('status');
    table.index(['company_id', 'status']);
    table.index('created_at');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('import_jobs');
}
