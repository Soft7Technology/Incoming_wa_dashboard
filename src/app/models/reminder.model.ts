import { BaseModel } from '@surefy/models/base.model';
import { v4 as uuid } from 'uuid';
import { MessageStatusUpdate } from '../interfaces/message.interface';
import { ReminderScope, ReminderRecord, ReminderCreateRecord } from '../interfaces/reminder.interface';

/** Persistence boundary for reminders, their attempts, and delivery callbacks. */
class ReminderModel extends BaseModel {
  constructor() {
    super('reminders');
  }
  private scopedQuery(scope: ReminderScope, connection = this.db) {
    const query = connection('reminders').where({
      'reminders.company_id': scope.companyId,
      'reminders.user_id': scope.ownerId,
    });
    if (scope.actorId !== scope.ownerId)
      query.whereIn(
        'contact_id',
        connection('contacts')
          .select('id')
          .where({ company_id: scope.companyId, user_id: scope.ownerId })
          .whereNull('deleted_at')
          .whereRaw('assigned_to @> ARRAY[?]::uuid[]', [scope.actorId]),
      );
    return query;
  }

  /** PostgreSQL commits all rows in this statement or none of them. */
  async createMany(records: ReminderCreateRecord[]): Promise<ReminderRecord[]> {
    if (!records.length) return [];
    const rows = records.map((record) => ({
      ...record,
      variables: JSON.stringify(record.variables ?? {}),
      parameter_mapping: record.parameter_mapping == null ? null : JSON.stringify(record.parameter_mapping),
      media_uploads: JSON.stringify(record.media_uploads ?? []),
    }));
    return this.query().insert(rows).returning('*');
  }

  async findOwned(scope: ReminderScope, id: string): Promise<ReminderRecord | undefined> {
    return this.scopedQuery(scope).where('reminders.id', id).first();
  }

  async findRecipient(scope: ReminderScope, id: string) {
    const query = this.db('contacts')
      .where({ id, company_id: scope.companyId, user_id: scope.ownerId })
      .whereNull('deleted_at');
    if (scope.actorId !== scope.ownerId) {
      query.whereRaw('assigned_to @> ARRAY[?]::uuid[]', [scope.actorId]);
    }
    return query.first();
  }

  async findApprovedTemplates(companyId: string, wabaId: string) {
    return this.db('templates')
      .where({ company_id: companyId, waba_id: wabaId, status: 'APPROVED' })
      .whereNull('deleted_at');
  }

  async findApprovedTemplate(companyId: string, wabaId: string, id: string) {
    return this.db('templates')
      .where({ id, company_id: companyId, waba_id: wabaId, status: 'APPROVED' })
      .whereNull('deleted_at')
      .first();
  }

  /** Aggregate visible schedules without loading the full reminder list. */
  async summary(scope: ReminderScope, timezone: string) {
    const row = await this.scopedQuery(scope).select(
      this.db.raw('COUNT(*) AS total_schedules'),
      this.db.raw("COUNT(*) FILTER (WHERE status = 'upcoming') AS upcoming"),
      this.db.raw(`COUNT(*) FILTER (
        WHERE status = 'upcoming'
          AND next_send_at >= (date_trunc('week', CURRENT_TIMESTAMP AT TIME ZONE ?) AT TIME ZONE ?)
          AND next_send_at < ((date_trunc('week', CURRENT_TIMESTAMP AT TIME ZONE ?) + interval '1 week') AT TIME ZONE ?)
      ) AS this_week`, [timezone, timezone, timezone, timezone]),
    ).first();
    return {
      total_schedules: Number(row?.total_schedules || 0),
      this_week: Number(row?.this_week || 0),
      upcoming: Number(row?.upcoming || 0),
      timezone,
    };
  }

  async findPage(
    scope: ReminderScope,
    filter: { status?: string; contact_id?: string; limit: number; offset: number },
  ) {
    const query = this.scopedQuery(scope);
    if (filter.status) query.where('reminders.status', filter.status);
    if (filter.contact_id) query.where('contact_id', filter.contact_id);
    const count = await query.clone().count('* as total').first();
    const items: ReminderRecord[] = await query
      .orderBy('created_at', 'desc')
      .orderBy('id')
      .limit(filter.limit)
      .offset(filter.offset);
    return { items, total: Number(count?.total || 0) };
  }

  /** Hold the row lock while the service checks whether the transition is allowed. */
  async updateOwned(
    scope: ReminderScope,
    id: string,
    changes: (reminder: ReminderRecord | undefined) => Promise<Partial<ReminderRecord> | null>,
  ) {
    return this.db.transaction(async (transaction) => {
      const reminder = await this.scopedQuery(scope, transaction).where('reminders.id', id).forUpdate().first();
      const values = await changes(reminder);
      if (!values) return reminder;
      const [updated] = await transaction('reminders')
        .where({ id })
        .update({
          ...values,
          ...(values.media_uploads !== undefined ? { media_uploads: JSON.stringify(values.media_uploads) } : {}),
          updated_at: new Date(),
        })
        .returning('*');
      return updated;
    });
  }

  async findHistory(id: string, limit: number, offset: number) {
    const attempts = await this.db('reminder_attempts')
      .where({ reminder_id: id })
      .orderBy('scheduled_at', 'desc')
      .limit(limit)
      .offset(offset);
    const messageIds = attempts.map((attempt) => attempt.wamid).filter(Boolean);
    const events = messageIds.length
      ? await this.db('reminder_delivery_events').whereIn('wamid', messageIds).orderBy('received_at')
      : [];
    return attempts.map((attempt) => ({
      ...attempt,
      delivery_updates: events.filter((event) => event.wamid === attempt.wamid),
    }));
  }

  /** Expired claims are paused, never retried automatically after an uncertain send. */
  async recoverStaleClaims() {
    await this.db.transaction(async (transaction) => {
      const stale = await transaction('reminders')
        .where({ status: 'sending' })
        .where('updated_at', '<', new Date(Date.now() - 15 * 60000))
        .forUpdate()
        .skipLocked();
      for (const row of stale) {
        await transaction('reminder_attempts').where({ reminder_id: row.id, status: 'sending' }).update({
          status: 'unknown',
          finished_at: new Date(),
          failure_reason: 'Send interrupted; delivery is unknown. Inspect history before resuming.',
        });
        await transaction('reminders').where({ id: row.id }).update({ status: 'paused', updated_at: new Date() });
      }
    });
  }

  /** Atomically reserve one occurrence across all worker processes. */
  async claimNextDue() {
    return this.db.transaction(async (transaction) => {
      const row = await transaction('reminders')
        .where({ status: 'upcoming' })
        .where('next_send_at', '<=', new Date())
        .orderBy('next_send_at')
        .forUpdate()
        .skipLocked()
        .first();
      if (!row) return null;
      const attemptId = uuid();
      await transaction('reminder_attempts').insert({
        id: attemptId,
        reminder_id: row.id,
        scheduled_at: row.next_send_at,
        attempted_at: new Date(),
        snapshot: JSON.stringify(row),
        status: 'sending',
      });
      await transaction('reminders')
        .where({ id: row.id })
        .update({ status: 'sending', last_attempt_id: attemptId, updated_at: new Date() });
      return { row, attemptId };
    });
  }

  async refreshClaim(id: string) {
    await this.query().where({ id, status: 'sending' }).update({ updated_at: new Date() });
  }

  async saveAttemptSnapshot(id: string, snapshot: unknown) {
    await this.db('reminder_attempts')
      .where({ id })
      .update({ snapshot: JSON.stringify(snapshot), attempted_at: new Date() });
  }

  /** Commit the result and recurrence together; preserve early delivery failures. */
  async completeAttempt(
    row: ReminderRecord,
    attemptId: string,
    wamid: string | null,
    failure: string | null,
    next: Date | null,
  ) {
    await this.db.transaction(async (transaction) => {
      const current = await transaction('reminders').where({ id: row.id }).forUpdate().first();
      const deliveryFailure = wamid
        ? await transaction('reminder_delivery_events').where({ wamid, status: 'failed' }).first()
        : null;
      if (deliveryFailure) failure = deliveryFailure.error?.message || 'Delivery failed';
      await transaction('reminder_attempts')
        .where({ id: attemptId })
        .update({ status: failure ? 'failed' : 'sent', wamid, failure_reason: failure, finished_at: new Date() });
      if (current.status !== 'sending') return;
      await transaction('reminders')
        .where({ id: row.id })
        .update({
          status: next ? 'upcoming' : failure ? 'failed' : 'sent',
          next_send_at: next,
          updated_at: new Date(),
        });
    });
  }

  /** Deduplicate callbacks and update only the occurrence that produced this message. */
  async recordDelivery(update: MessageStatusUpdate) {
    // Persist before looking up the message: a callback can beat its WAMID update.
    await this.db('reminder_delivery_events')
      .insert({
        wamid: update.wamid,
        status: update.status,
        meta_timestamp: String(update.timestamp),
        error: update.error ? JSON.stringify(update.error) : null,
      })
      .onConflict(['wamid', 'status', 'meta_timestamp'])
      .ignore();
    await this.db.transaction(async (transaction) => {
      const attempt = await transaction('reminder_attempts')
        .where({ wamid: update.wamid })
        .orWhereIn('id', transaction('messages').select('id').where({ wamid: update.wamid }))
        .first();
      if (!attempt) return;
      await transaction('reminders').where({ id: attempt.reminder_id }).forUpdate().first();
      await transaction('reminder_attempts').where({ id: attempt.id }).update({ wamid: update.wamid });
      if (update.status === 'failed') {
        await transaction('reminder_attempts')
          .where({ id: attempt.id })
          .update({ status: 'failed', failure_reason: update.error?.message || 'Delivery failed' });
        await transaction('reminders')
          .where({ id: attempt.reminder_id, frequency: 'once', status: 'sent', last_attempt_id: attempt.id })
          .update({ status: 'failed', updated_at: new Date() });
      }
    });
  }
}
export default new ReminderModel();
