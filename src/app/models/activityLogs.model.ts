import { ActivityQuery, ActivityFilters, ActivityLogInput } from '../interfaces/activity.interface';
import { parseActivityFilters, parseActivityPagination, parseNotificationIds } from '../utils/activityFilters';
import { BaseModel } from '@surefy/models/base.model';
import { Knex } from 'knex';
import HTTP403Error from '@surefy/exceptions/HTTP403Error';
import { activityContext, markActivityRecorded } from '../utils/activityContext';

const isCompanyAdministrator = (role: string): boolean => ['admin', 'company', 'superadmin'].includes(role);
const NOTIFICATION_LIMIT = 50;
const DAY_MS = 86_400_000;

class ActivityLogsModel extends BaseModel {
  constructor() {
    super('activity_logs');
  }

  async create(data: ActivityLogInput, trx?: Knex.Transaction) {
    const context = activityContext.getStore();
    // Attribute request activity to the authenticated actor, not a client-supplied user ID.
    const entry = context
      ? {
          ...data,
          user_id: context.userId,
          company_id: data.company_id ?? context.companyId,
          request_method: context.request_method,
          api_endpoint: context.api_endpoint,
          ip_address: context.ip_address,
          user_agent: context.user_agent,
        }
      : data;
    const result = await super.create(entry, trx);
    markActivityRecorded();
    return result;
  }

  /** Every read/update starts here so request filters cannot expand visibility. */
  private scopedQuery(userId: string, companyId: string | undefined, role: string) {
    if (!userId || !role) throw new HTTP403Error({ message: 'Authenticated user is required' });
    const query = this.query()
      .from('activity_logs as a')
      .leftJoin('users as u', 'u.id', 'a.user_id')
      .whereNull('a.deleted_at');
    if (role !== 'superadmin') {
      if (!companyId) {
        if (isCompanyAdministrator(role)) throw new HTTP403Error({ message: 'Company context is required' });
      } else {
        // Recover visibility of legacy logs whose company_id was not populated.
        query.where((builder) =>
          builder
            .where('a.company_id', companyId)
            .orWhere((legacy) => legacy.whereNull('a.company_id').where('u.company_id', companyId)),
        );
      }
      if (!isCompanyAdministrator(role)) query.where('a.user_id', userId);
    }
    return query;
  }

  private applyFilters(query: Knex.QueryBuilder, filters: ActivityFilters, now = new Date()): Knex.QueryBuilder {
    const { type, action, status, userId, companyId, entityId, read, search, from, to, timeFrame } = filters;
    for (const [column, value] of [
      ['entity_type', type],
      ['action', action],
      ['status', status],
    ]) {
      if (value) query.andWhereRaw('UPPER(??) = ?', [`a.${column}`, value.toUpperCase()]);
    }
    if (userId) query.andWhere('a.user_id', userId);
    if (companyId) query.andWhere('a.company_id', companyId);
    if (entityId) query.andWhere('a.entity_id', entityId);
    if (read !== undefined) query.andWhere('a.read', read);
    if (search) {
      const pattern = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
      // Group search OR clauses beneath the mandatory access predicates.
      query.andWhere((builder) => {
        for (const column of ['a.description', 'a.entity_type', 'a.action', 'u.name', 'u.email']) {
          builder.orWhereILike(column, pattern);
        }
      });
    }
    if (from) query.andWhere('a.created_at', '>=', from);
    if (to) query.andWhere('a.created_at', '<', to);
    const frame = timeFrame;
    if (frame) {
      const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      if (frame === 'today' || frame === 'yesterday') {
        const start = new Date(today.getTime() - (frame === 'yesterday' ? DAY_MS : 0));
        query.andWhere('a.created_at', '>=', start).andWhere('a.created_at', '<', new Date(start.getTime() + DAY_MS));
      } else if (['7days', '30days', '90days'].includes(frame)) {
        query
          .andWhere('a.created_at', '>=', new Date(now.getTime() - parseInt(frame, 10) * DAY_MS))
          .andWhere('a.created_at', '<=', now);
      }
    }
    return query;
  }

  async getAllActivities(userId: string, companyId: string | undefined, role: string, filters: ActivityQuery = {}) {
    const { page, limit, offset, column, direction } = parseActivityPagination(filters);
    const query = this.applyFilters(this.scopedQuery(userId, companyId, role), parseActivityFilters(filters));
    // Independent clones keep count and results on identical filters; ID stabilizes ties.
    const [rows, total] = await Promise.all([
      query
        .clone()
        .select('a.*', 'u.name as user_name', 'u.email as user_email')
        .orderBy(`a.${column}`, direction)
        .orderBy('a.id', direction)
        .limit(limit)
        .offset(offset),
      query.clone().count('a.id as total').first(),
    ]);
    const count = Number(total?.total || 0);
    return { data: rows, pagination: { page, limit, total: count, totalPages: Math.ceil(count / limit) } };
  }

  async getActivityNotifications(
    userId: string,
    companyId: string | undefined,
    role: string,
    filters: ActivityQuery = {},
  ) {
    return this.applyFilters(
      this.scopedQuery(userId, companyId, role).where('a.user_id', userId),
      parseActivityFilters(filters),
    )
      .select('a.*', 'u.name as user_name', 'u.email as user_email')
      .orderBy('a.created_at', 'desc')
      .orderBy('a.id', 'desc')
      .limit(NOTIFICATION_LIMIT);
  }

  async getCompanyNotifications(
    userId: string,
    companyId: string | undefined,
    role: string,
    filters: ActivityQuery = {},
  ) {
    if (!isCompanyAdministrator(role)) throw new HTTP403Error({ message: 'Company admin access is required' });
    return this.applyFilters(this.scopedQuery(userId, companyId, role), parseActivityFilters(filters))
      .select('a.*', 'u.name as user_name', 'u.email as user_email')
      .orderBy('a.created_at', 'desc')
      .orderBy('a.id', 'desc')
      .limit(NOTIFICATION_LIMIT);
  }

  async markRead(userId: string, companyId: string | undefined, role: string, data: unknown) {
    const ids = parseNotificationIds(data);
    // Authorize inside the UPDATE subquery; never trust IDs provided by the caller.
    const accessible = this.scopedQuery(userId, companyId, role).select('a.id').whereIn('a.id', ids);
    await this.query().whereIn('id', accessible).update({ read: true });
    return true;
  }
}
export default new ActivityLogsModel();
