export interface Company {
  id: string;
  name: string;
  email: string;
  phone?: string;
  business_id?: string;
  api_key?: string;
  webhook_url?: string;
  webhook_verify_token?: string;
  status: 'active' | 'inactive' | 'suspended';
  credit_balance: number;
  meta_config?: any;
  settings?: any;
  created_at: Date;
  updated_at: Date;
  deleted_at?: Date;
}

export interface CreateCompanyDto {
  name: string;
  email: string;
  phone?: string;
  business_id?: string;
  webhook_url?: string;
  meta_config?: any;
  settings?: any;
  initial_credit?: number;
  user?: {
    name: string;
    email?: string;
    phone?: string;
    password: string;
  };
}

export interface UpdateCompanyDto {
  name?: string;
  email?: string;
  phone?: string;
  webhook_url?: string;
  status?: 'active' | 'inactive' | 'suspended';
  meta_config?: any;
  settings?: any;
}
