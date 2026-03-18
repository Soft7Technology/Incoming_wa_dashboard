export interface Webhook {
  id: string;
  company_id: string;
  url: string;
  secret?: string;
  status: 'active' | 'inactive' | 'failed';
  events: string[];
  retry_count: number;
  max_retries: number;
  timeout_ms: number;
  last_triggered_at?: Date;
  last_success_at?: Date;
  last_failure_at?: Date;
  headers?: any;
  created_at: Date;
  updated_at: Date;
  deleted_at?: Date;
}

export interface WebhookLog {
  id: string;
  webhook_id: string;
  company_id: string;
  event_type: string;
  payload: any;
  status: 'pending' | 'success' | 'failed' | 'retry';
  attempt_count: number;
  response_status_code?: number;
  response_body?: string;
  error_message?: string;
  duration_ms?: number;
  sent_at?: Date;
  created_at: Date;
  updated_at: Date;
}

export interface CreateWebhookDto {
  company_id: string;
  url: string;
  secret?: string;
  events: string[];
  headers?: any;
  max_retries?: number;
  timeout_ms?: number;
}

export interface WebhookEvent {
  type: string;
  company_id: string;
  data: any;
  timestamp: Date;
}
