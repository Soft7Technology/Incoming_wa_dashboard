export interface AIAssistant {
  id?: number;
  user_id: string;
  name: string;
  role: string;
  status?: 'ACTIVE' | 'INACTIVE';
  prompt_type: string;
  predefined_prompt?: string;
  custom_prompt?: string;
  provider: string;
  model: string;
  api_key?: string;
  created_at?: string;
  updated_at?: string;
}
