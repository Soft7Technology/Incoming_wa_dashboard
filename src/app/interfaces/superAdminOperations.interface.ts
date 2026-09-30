import { SuperAdminFilters } from './superAdmin.interface';
export type ReportResource = 'subscriptions' | 'plans' | 'payments' | 'tickets';
export interface OperationsFilters extends SuperAdminFilters {
  forwarded?: boolean;
  assigned_to?: string;
}
