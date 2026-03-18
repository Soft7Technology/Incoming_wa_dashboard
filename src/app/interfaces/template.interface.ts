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
  waba_id: string;
  name: string;
  language: string;
  category: 'AUTHENTICATION' | 'MARKETING' | 'UTILITY';
  components: TemplateComponent[];
}

export interface TemplateComponent {
  type: 'HEADER' | 'BODY' | 'FOOTER' | 'BUTTONS';
  format?: 'TEXT' | 'IMAGE' | 'VIDEO' | 'DOCUMENT';
  text?: string;
  example?: any;
  buttons?: TemplateButton[];
}

export interface TemplateButton {
  type: 'QUICK_REPLY' | 'URL' | 'PHONE_NUMBER';
  text: string;
  url?: string;
  phone_number?: string;
}

export interface SyncTemplatesDto {
  company_id: string;
  waba_id: string;
}
