/** Authenticated account context; never accepted from a request body. */
export interface ReminderScope {
  companyId: string;
  ownerId: string;
  actorId: string;
}
export type ReminderFrequency = 'once' | 'yearly';
export type ReminderStatus = 'upcoming' | 'sending' | 'sent' | 'failed' | 'paused' | 'cancelled';
export type ReminderAction = 'pause' | 'resume' | 'cancel';
export interface ReminderInput {
  name: string;
  contact_id: string;
  phone_number_id: string;
  template_id: string;
  frequency: ReminderFrequency;
  timezone: string;
  local_datetime: string;
  variables?: Record<string, string>;
  parameter_mapping?: Record<string, string> | null;
  media_uploads?: ReminderMedia[];
}
export interface ReminderRecord extends ReminderInput {
  id: string;
  company_id: string;
  user_id: string;
  status: ReminderStatus;
  next_send_at: Date | null;
  last_attempt_id?: string;
}

export interface ReminderMedia {
  type: 'image' | 'video' | 'document';
  media_id?: string;
  url?: string;
  link?: string;
  filename?: string;
}

/** A shared schedule creates independently managed reminders for each recipient. */
export interface BulkReminderInput extends Omit<ReminderInput, 'contact_id'> {
  contact_ids: string[];
}
export type ReminderCreateRecord = ReminderInput & {
  company_id: string;
  user_id: string;
  next_send_at: Date | null;
};
