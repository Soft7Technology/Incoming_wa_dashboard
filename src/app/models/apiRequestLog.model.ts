import db from '@surefy/database';
import { apiLogBody } from '../utils/apiLogBody';

export interface ApiLogScope { userId: string; companyId: string }
export interface ApiLogFilters {
  page: number; limit: number; api_key_id?: string; request_id?: string;
  outcome?: string; http_status?: number; method?: string; endpoint?: string;
  from_date?: Date; to_date?: Date; status?: string;
}
const liveStatus = 'COALESCE(m.status::text, a.status)';

class ApiRequestLogModel {
  create(data: any) { return db('api_request_logs').insert(data); }
  finish(id: string, data: any) {
    return db('api_request_logs').where({ id, outcome: 'pending' }).update(data);
  }
  private requests(scope: ApiLogScope, filter: ApiLogFilters) {
    const query = db('api_request_logs as r').where({ 'r.user_id': scope.userId, 'r.company_id': scope.companyId });
    for (const key of ['api_key_id', 'outcome', 'http_status', 'method', 'endpoint'] as const) {
      if (filter[key] !== undefined) query.where(`r.${key}`, filter[key]!);
    }
    if (filter.request_id) query.where('r.id', filter.request_id);
    if (filter.from_date) query.where('r.created_at', '>=', filter.from_date);
    if (filter.to_date) query.where('r.created_at', '<=', filter.to_date);
    return query;
  }
  private messages(scope: ApiLogScope, filter: ApiLogFilters) {
    const query = this.requests(scope, filter)
      .join('api_request_messages as a', 'a.request_id', 'r.id')
      .leftJoin('messages as m', function () {
        this.on('m.id', '=', 'a.id').andOn('m.user_id', '=', 'r.user_id').andOn('m.company_id', '=', 'r.company_id');
      });
    if (filter.status) query.whereRaw(`${liveStatus} = ?`, [filter.status]);
    return query;
  }
  async list(scope: ApiLogScope, filter: ApiLogFilters, messages = false) {
    // A single snapshot keeps the page and total consistent during concurrent traffic.
    return db.transaction(async trx => {
      const query = (messages ? this.messages(scope, filter) : this.requests(scope, filter)).transacting(trx);
      const count: any = await query.clone().count('* as total').first();
      const columns = messages
        ? ['a.id as message_id', 'a.request_id', 'a.request_body', 'a.created_at', 'm.wamid',
          db.raw("COALESCE(m.to_phone, a.request_body->>'to') as to_phone"),
          db.raw("COALESCE(m.type::text, a.request_body->>'type') as type"),
          'm.error_code', 'm.queued_at', 'm.sent_at', 'm.delivered_at', 'm.read_at', 'm.failed_at',
          db.raw(`${liveStatus} as status`), db.raw('COALESCE(m.error_message, a.error_message) as error_message')]
        : ['r.id', 'r.api_key_id', 'r.key_prefix', 'r.method', 'r.endpoint', 'r.query', 'r.request_body',
          'r.http_status', 'r.outcome', 'r.duration_ms', 'r.created_at', 'r.completed_at'];
      const items = await query.clone().select(columns)
        .orderBy(messages ? 'a.created_at' : 'r.created_at', 'desc')
        .orderBy(messages ? 'a.id' : 'r.id', 'desc')
        .limit(filter.limit).offset((filter.page - 1) * filter.limit);
      // Message errors originate in provider responses and are sanitized on read too.
      if (messages) items.forEach((item: any) => { item.error_message = apiLogBody(item.error_message); });
      const total = Number(count.total);
      return { items, pagination: { page: filter.page, limit: filter.limit, total,
        total_pages: Math.ceil(total / filter.limit), has_next: filter.page * filter.limit < total } };
    }, { isolationLevel: 'repeatable read', readOnly: true });
  }
  detail(scope: ApiLogScope, id: string) {
    return this.requests(scope, { page: 1, limit: 1, request_id: id }).select('r.*').first();
  }
  async summary(scope: ApiLogScope, filter: ApiLogFilters) {
    return db.transaction(async trx => {
      const calls = await this.requests(scope, filter).transacting(trx).select('r.outcome').count('* as count').groupBy('r.outcome');
      const http = await this.requests(scope, filter).transacting(trx).select('r.http_status').count('* as count').groupBy('r.http_status');
      const messages = await this.messages(scope, filter).transacting(trx).select(db.raw(`${liveStatus} as status`))
        .count('* as count').groupByRaw(liveStatus);
      const requestCounts: Record<string, number> = { total: 0, success: 0, failed: 0, pending: 0, aborted: 0 };
      for (const row of calls as any[]) { requestCounts[row.outcome] = Number(row.count); requestCounts.total += Number(row.count); }
      const messageCounts: Record<string, number> = { total: 0, queued: 0, processing: 0, sent: 0, delivered: 0, read: 0, failed: 0, unknown: 0 };
      for (const row of messages as any[]) { messageCounts[row.status] = Number(row.count); messageCounts.total += Number(row.count); }
      return { requests: requestCounts, http_statuses: http.map((row: any) => ({ http_status: row.http_status, count: Number(row.count) })), messages: messageCounts };
    }, { isolationLevel: 'repeatable read', readOnly: true });
  }
  async reserveMessages(requestId: string, messages: { id: string; body: unknown }[]) {
    await db('api_request_messages').insert(messages.map(message => ({
      id: message.id, request_id: requestId, request_body: JSON.stringify(apiLogBody(message.body)), status: 'queued',
    })));
  }
  async startMessage(requestId: string, id: string, body: unknown) {
    await db('api_request_messages').insert({ id, request_id: requestId,
      request_body: JSON.stringify(apiLogBody(body)), status: 'processing' }).onConflict('id').ignore();
    await db('api_request_messages').where({ id, request_id: requestId }).update({ status: 'processing', updated_at: db.fn.now() });
  }
  failMessage(requestId: string, id: string, error: string, uncertain = false) {
    return db('api_request_messages').where({ id, request_id: requestId })
      .update({ status: uncertain ? 'unknown' : 'failed', error_message: apiLogBody(error), updated_at: db.fn.now() });
  }
  async failJob(requestId: string, uncertain = false) {
    // Never assert that an interrupted in-flight send failed; Meta may have accepted it.
    await db('api_request_messages').where({ request_id: requestId }).whereIn('status', ['queued', 'processing'])
      .update({ status: uncertain ? 'unknown' : db.raw("CASE WHEN status = 'queued' THEN 'failed' ELSE 'unknown' END"),
        error_message: 'Bulk job stopped. Check delivery status before retrying.', updated_at: db.fn.now() });
  }
}
export default new ApiRequestLogModel();
