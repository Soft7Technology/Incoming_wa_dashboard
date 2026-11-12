import { Knex } from 'knex';

// Keep historical malformed numeric records recoverable. Import and messaging
// validation remain strict; this exception requires both no country and invalid.
export async function up(knex: Knex): Promise<void> {
  await knex.raw('ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_phone_digits_check');
  await knex.raw(`ALTER TABLE contacts ADD CONSTRAINT contacts_phone_digits_check CHECK (
    (phone_number ~ '^[+][0-9]+$' AND country_code IS NULL AND is_valid IS FALSE)
    OR (phone_number ~ '^[+][0-9]{4,15}$' AND country_code IS NOT NULL
      AND country_code ~ '^[1-9][0-9]{0,2}$' AND phone_number LIKE '+' || country_code || '%')
  )`);
}

export async function down(knex: Knex): Promise<void> {
  // Validation fails atomically if any preserved historical record is too long.
  await knex.raw('ALTER TABLE contacts DROP CONSTRAINT contacts_phone_digits_check');
  await knex.raw(`ALTER TABLE contacts ADD CONSTRAINT contacts_phone_digits_check CHECK (
    phone_number ~ '^[+][0-9]{4,15}$' AND ((country_code IS NULL AND is_valid IS FALSE)
      OR (country_code IS NOT NULL AND country_code ~ '^[1-9][0-9]{0,2}$'
        AND phone_number LIKE '+' || country_code || '%'))
  )`);
}
