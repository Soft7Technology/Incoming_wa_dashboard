export interface Template {
  id: string;
  company_id: string;
  waba_id: string;
  template_id?: string;
  name: string;
  language: string;
  category: 'AUTHENTICATION' | 'MARKETING' | 'UTILITY';
  status: 'APPROVED' | 'PENDING' | 'REJECTED' | 'DISABLED';
  rejection_reason?: string;
  components?: any;
  meta_data?: any;
  synced_at?: Date;
  created_at: Date;
  updated_at: Date;
  deleted_at?: Date;
}

export interface CreateTemplateDto {
  company_id: string;
  user_id: string;
  waba_id: string;
  name: string;
  language: string;
  category: 'AUTHENTICATION' | 'MARKETING' | 'UTILITY';
  components: TemplateComponent[];
  parameter_format?: 'POSITIONAL' | 'NAMED';
  message_send_ttl_seconds?: number;
}

export interface TemplateComponent {
  [key: string]: unknown;
  type: string;
  format?: string;
  text?: string;
  example?: any;
  buttons?: TemplateButton[];
}

export interface TemplateButton {
  [key: string]: unknown;
  type: string;
  text: string;
  url?: string;
  phone_number?: string;
}

export interface SyncTemplatesDto {
  company_id: string;
  waba_id: string;
}

export interface UpdateTemplateDto {
  category?: CreateTemplateDto['category'];
  components?: TemplateComponent[];
  message_send_ttl_seconds?: number;
}

export interface TemplateAccount {
  companyId: string;
  userId: string;
}
