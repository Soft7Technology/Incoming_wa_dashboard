import { Knex } from 'knex';
import { down as restoreSplit, up as restoreInternational } from './20260930000001_contacts_international_phone';

// Forward migration also repairs deployments that already applied international storage.
export async function up(knex: Knex): Promise<void> { await restoreSplit(knex); }
export async function down(knex: Knex): Promise<void> { await restoreInternational(knex); }
