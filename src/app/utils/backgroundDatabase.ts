import type { Knex } from 'knex';
import { reportBackgroundError } from '@surefy/utils/databaseErrors';

export type SchemaRequirements = Record<string, string[]>;

export async function checkDatabaseSchema(db: Knex, requirements: SchemaRequirements): Promise<void> {
  for (const [table, columns] of Object.entries(requirements)) {
    // Validate the actual search_path, columns and read permissions without rows or writes.
    await db(table).select(columns).limit(0).timeout(5000);
  }
}

export const backgroundSchemas: Record<string, SchemaRequirements> = {
  'media-upload': {
    media_gallery: ['id', 'user_id', 'name', 'original_name', 'firebase_url', 'firebase_file_name', 'size', 'mimetype', 'deleted_at'],
  },
  'campaign-execution': {
    campaigns: ['id', 'status', 'company_id', 'user_id', 'failure_reason'],
    campaign_messages: ['id', 'status', 'retry_after'],
    contacts: ['id', 'phone_number'], templates: ['id'], phone_numbers: ['id'], messages: ['id', 'status', 'wamid'],
  },
  'contact-import': {
    import_jobs: ['id', 'status', 'list_id', 'phone_number_id', 'import_options', 'total_rows',
      'processed_rows', 'successful_rows', 'failed_rows', 'skipped_rows', 'progress_percentage', 'started_at', 'completed_at', 'failed_at'],
    contacts: ['id', 'phone_number', 'country_code', 'phone_number_id'], contact_lists: ['id'],
    contact_list_relations: ['contact_id', 'list_id'], contact_tags: ['id'], contact_tag_relations: ['contact_id', 'tag_id'],
  },
  'bulk-message-send': {
    users: ['id'], companies: ['id'], phone_numbers: ['id'], messages: ['id', 'status', 'wamid'],
  },
  'BulkTable-execution': {
    contacts: ['id', 'assigned_to'], campaigns: ['id', 'assigned_to'], chat_bot: ['id', 'assigned_to'],
  },
  'chatbot-delay': {
    chat_sessions: ['id', 'active', 'current_node_id', 'variables'], chat_bot: ['id'],
    chat_bot_node: ['id'], chat_bot_edge: ['id'], chat_bot_phone_numbers: ['id'], messages: ['id', 'status', 'wamid'],
  },
  reminders: {
    reminders: ['id', 'status', 'updated_at', 'next_send_at', 'last_attempt_id'],
    reminder_attempts: ['id', 'status', 'finished_at'], reminder_delivery_events: ['id', 'wamid', 'status'],
  },
};

/** One bounded retry loop per feature, shared by concurrent jobs. */
export class BackgroundDatabaseGate {
  private validUntil = 0;
  private retryAt = 0;
  private failures = 0;
  private generation = 0;
  private checking?: Promise<boolean>;

  constructor(private readonly name: string, private readonly now = () => Date.now()) {}

  fail(error: unknown): void {
    this.generation++;
    this.validUntil = 0;
    // Concurrent failures must not multiply the delay or flood logs.
    if (this.now() < this.retryAt) return;
    this.failures++;
    const retryInMs = Math.min(300000, 30000 * 2 ** Math.min(this.failures - 1, 4));
    this.retryAt = this.now() + retryInMs;
    reportBackgroundError(this.name, error, { retryInMs });
  }

  async check(probe: () => Promise<void>): Promise<boolean> {
    if (this.now() < this.retryAt) return false;
    if (this.now() < this.validUntil) return true;
    if (this.checking) return this.checking;
    const generation = this.generation;
    this.checking = (async () => {
      try {
        await probe();
        if (generation !== this.generation) return false;
        if (this.failures) console.info(`[${this.name}] Database recovered; background work can resume`);
        this.failures = 0;
        this.retryAt = 0;
        this.validUntil = this.now() + 60000;
        return true;
      } catch (error) {
        this.fail(error);
        return false;
      }
    })().finally(() => { this.checking = undefined; });
    return this.checking;
  }
}
