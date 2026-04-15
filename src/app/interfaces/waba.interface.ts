export interface WabaAccount {
  id: string;
  company_id: string;
  waba_id: string;
  name?: string;
  currency?: string;
  timezone?: string;
  message_template_namespace?: string;
  status: 'active' | 'inactive' | 'restricted';
  meta_data?: any;
  created_at: Date;
  updated_at: Date;
  deleted_at?: Date;
}

export interface PhoneNumber {
  id: string;
  company_id: string;
  waba_id: string;
  phone_number_id: string;
  display_phone_number: string;
  verified_name?: string;
  code_verification_status?: string;
  quality_rating?: string;
  status: 'active' | 'inactive' | 'pending';
  messaging_limit_tier?: number;
  capabilities?: any;
  meta_data?: any;
  created_at: Date;
  updated_at: Date;
  deleted_at?: Date;
}

export interface CreateWabaDto {
  user_id: string;
  waba_id: string;
  company_id: string;
  name?: string;
  currency?: string;
  timezone?: string;
  meta_data?: any;
}

export interface CreatePhoneNumberDto {
  company_id: string;
  waba_id: string;
  phone_number_id: string;
  display_phone_number: string;
  verified_name?: string;
  quality_rating?: string;
  status?:string
  messaging_limit_tier?: number;
  capabilities?: any;
  meta_data?:any
}
