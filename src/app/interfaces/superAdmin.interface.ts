export type AccountStatus = 'active' | 'inactive' | 'suspended';
export interface CompanyOverviewStats {
  total_message: number;
  delivered_messages: number;
  failed_messages: number;
  received_messages: number;
  templates: number;
  message_templates: number;
}
export interface SuperAdminFilters {
  page: number;
  limit: number;
  search?: string;
  status?: string;
  company_id?: string;
  user_id?: string;
  domain_status?: string;
  from?: string;
  to?: string;
}
export interface CompanyFields {
  name: string;
  email: string;
  phone?: string;
  business_id?: string;
}
export interface InitialAdmin {
  name: string;
  email: string;
  phone?: string;
  password: string;
}
export interface CreateCompanyInput extends CompanyFields {
  user: InitialAdmin;
}
export interface CreditInput {
  amount: string;
  reason: string;
  request_id: string;
}
export type UserCollection = 'activities' | 'campaigns' | 'messages' | 'contacts';
export type CompanyCollection = 'users' | 'domains' | 'activities' | 'credits' | 'audit' | 'messages' | 'campaigns' | 'contacts';
