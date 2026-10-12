import { Knex } from 'knex';

const originalTypes = [
  'text', 'image', 'video', 'document', 'audio', 'template',
  'interactive', 'location', 'contacts', 'sticker',
];

async function replaceTypeCheck(knex: Knex, types: string[]): Promise<void> {
  // PostgreSQL CHECK definitions require literals rather than bind parameters.
  const allowedTypes = types.map(type => knex.raw('?', [type]).toQuery()).join(', ');
  // Handle the deployed constraint name and Knex's default enum check name.
  await knex.raw(`
    ALTER TABLE messages
      DROP CONSTRAINT IF EXISTS message_type_check,
      DROP CONSTRAINT IF EXISTS messages_type_check,
      ADD CONSTRAINT message_type_check CHECK (type IN (${allowedTypes}))
  `);
}

export async function up(knex: Knex): Promise<void> {
  await replaceTypeCheck(knex, [...originalTypes, 'reaction', 'unsupported']);
}

export async function down(knex: Knex): Promise<void> {
  // Validation fails atomically if newer message types exist, preserving their data.
  await replaceTypeCheck(knex, originalTypes);
}
