import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Preserve Meta's full template name: truncation would break template lookup and sending.
  await knex.raw('ALTER TABLE templates ALTER COLUMN name TYPE text');
}

export async function down(knex: Knex): Promise<void> {
  // Reject rollback if longer names exist rather than silently truncating them.
  await knex.raw(`
    DO $$
    BEGIN
      LOCK TABLE templates IN ACCESS EXCLUSIVE MODE;
      IF EXISTS (SELECT 1 FROM templates WHERE char_length(name) > 255) THEN
        RAISE EXCEPTION 'Cannot restore templates.name to varchar(255): longer template names exist';
      END IF;
      ALTER TABLE templates ALTER COLUMN name TYPE varchar(255);
    END $$;
  `);
}
