import { BaseModel } from '@surefy/models/base.model';
import { upperCase } from 'lodash';

class ActivityLogsModel extends BaseModel {
  constructor() {
    super('activity_logs');
  }


  async getAllActivities(
    user_id: string,
    company_id: string,
    role: string,
    filters: any
  ) {
    console.log("Company Id", company_id,role)
    const isSuperAdmin = role === 'superadmin';

    const page = Number(filters?.page) || 1;
    const limit = Number(filters?.limit) || 10;

    console.log("Filters",filters)

    const type =  upperCase(filters?.type)
    const search = filters?.search?.trim();

    const sortedBy = filters?.sorted_by || 'created_at';
    const sortOrder =
      filters?.sort_order?.toLowerCase() === 'asc'
        ? 'asc'
        : 'desc';

    const offset = (page - 1) * limit;

    const query = this.query().whereNull('deleted_at');

    if (!isSuperAdmin) {
      if (!company_id) {
        throw new Error('company_id is required for non-superadmin');
      }

      query.where('company_id', company_id);
    }

    if (type) {
      query.where('entity_type', type);
    }

    if (search) {
      query.andWhere((builder) => {
        builder
          .whereILike('description', `%${search}%`)
          .orWhereILike('entity_type', `%${search}%`);
      });
    }

    // Whitelist sortable columns
    const allowedSortColumns = [
      'created_at',
      'updated_at',
      'entity_type',
      'description',
    ];

    const orderByColumn = allowedSortColumns.includes(sortedBy)
      ? sortedBy
      : 'created_at';

    const totalQuery = query.clone();

    const [activities, totalResult] = await Promise.all([
      query
        .orderBy(orderByColumn, sortOrder)
        .limit(limit)
        .offset(offset),

      totalQuery.count('id as total').first(),
    ]);

    return {
      data: activities,
      pagination: {
        page,
        limit,
        total: Number(totalResult?.total || 0),
        totalPages: Math.ceil(
          Number(totalResult?.total || 0) / limit
        ),
      },
    };
  }

  async getActivityNotifications(
    user_id: string,
    company_id: string,
    role: string,
    filters: any
  ) {
    const query = this.query().whereNull('deleted_at');

    // User-specific notifications
    query.where('user_id', user_id);

    const type = upperCase(filters.type)

    if (filters?.type) {
      query.where('entity_type', type);
    }

    if(filters.action){
      query.where('action',filters?.action)
    }

    const now = new Date();

    switch (filters?.time_frame) {
      case 'today':
        query.whereRaw('DATE(created_at) = CURRENT_DATE');
        break;

      case 'yesterday':
        query.whereRaw(
          "DATE(created_at) = CURRENT_DATE - INTERVAL '1 day'"
        );
        break;

      case '7days':
        query.where(
          'created_at',
          '>=',
          new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
        );
        break;

      case '30days':
        query.where(
          'created_at',
          '>=',
          new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
        );
        break;

      case '90days':
        query.where(
          'created_at',
          '>=',
          new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000)
        );
        break;
    }

    return query
      .orderBy('created_at', 'desc')
      .limit(50);
  }

  async getCompanyNotifications(
    user_id: string,
    company_id: string,
    role: string,
    filters: any
  ) {
    console.log("CompanyId",company_id)
    const query = this.query().whereNull('deleted_at');

    // User-specific notifications
    query.where('company_id', company_id);

    const type = upperCase(filters.type)

    if (filters?.type) {
      query.where('entity_type', type);
    }

    if(filters.action){
      query.where('action',filters?.action)
    }

    const now = new Date();

    switch (filters?.time_frame) {
      case 'today':
        query.whereRaw('DATE(created_at) = CURRENT_DATE');
        break;

      case 'yesterday':
        query.whereRaw(
          "DATE(created_at) = CURRENT_DATE - INTERVAL '1 day'"
        );
        break;

      case '7days':
        query.where(
          'created_at',
          '>=',
          new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
        );
        break;

      case '30days':
        query.where(
          'created_at',
          '>=',
          new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
        );
        break;

      case '90days':
        query.where(
          'created_at',
          '>=',
          new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000)
        );
        break;
    }

    return query
      .orderBy('created_at', 'desc')
      .limit(50);
  }
}

export default new ActivityLogsModel();