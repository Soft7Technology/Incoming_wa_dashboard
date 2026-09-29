/** Raw query values remain unknown until validated; Express may supply arrays/objects. */
export type ActivityQuery = Record<string, unknown>;

export interface ActivityLogInput {
  action: string;
  entity_type: string;
  description: string;
  user_id?: string;
  company_id?: string | null;
  [field: string]: unknown;
}

export interface ActivityFilters {
  type?: string;
  action?: string;
  status?: string;
  userId?: string;
  companyId?: string;
  entityId?: string;
  read?: boolean;
  search?: string;
  from?: Date;
  to?: Date;
  timeFrame?: 'today' | 'yesterday' | '7days' | '30days' | '90days';
}

export const ACTIVITY_SORT_COLUMNS = [
  'created_at',
  'updated_at',
  'entity_type',
  'description',
  'action',
  'status',
] as const;
export type ActivitySortColumn = (typeof ACTIVITY_SORT_COLUMNS)[number];

export interface ActivityPagination {
  page: number;
  limit: number;
  offset: number;
  column: ActivitySortColumn;
  direction: 'asc' | 'desc';
}
