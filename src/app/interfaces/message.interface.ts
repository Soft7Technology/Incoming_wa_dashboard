export interface Message {
  id: string;
  company_id: string;
  phone_number_id: string;
  wamid?: string;
  direction: 'inbound' | 'outbound';
  type: 'text' | 'image' | 'video' | 'document' | 'audio' | 'template' | 'interactive' | 'location' | 'contacts' | 'sticker';
  from_phone: string;
  to_phone: string;
  status: 'queued' | 'sent' | 'delivered' | 'read' | 'failed' | 'deleted';
  error_message?: string;
  error_code?: string;
  content?: any;
  context?: any;
  template_id?: string;
  campaign_id?: string;
  cost?: number;
  queued_at?: Date;
  sent_at?: Date;
  delivered_at?: Date;
  read_at?: Date;
  failed_at?: Date;
  created_at: Date;
  updated_at: Date;
}

export interface SendMessageDto {
  company_id: string;
  campaign_id: string | undefined | null;
  phone_number_id: string;
  to: string;
  type: 'text' | 'template' | 'image' | 'video' | 'document' | 'audio';
  text?: {
    body: string;
    preview_url?: boolean;
  };
  template?: {
    name: string;
    language: string;
    components?: any[];
  };
  image?: {
    link?: string;
    id?: string;
    caption?: string;
  };
  video?: {
    link?: string;
    id?: string;
    caption?: string;
  };
  document?: {
    link?: string;
    id?: string;
    caption?: string;
    filename?: string;
  };
  audio?: {
    link?: string;
    id?: string;
  };
  context?: {
    message_id: string;
  };
}

export interface MarkAsReadDto {
  company_id: string;
  phone_number_id: string;
  message_id: string;
}

export interface MessageStatusUpdate {
  wamid: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  timestamp: number;
  error?: {
    code: string;
    message: string;
  };
}

export interface BulkSendMessageDto {
  phone_number_id: string;
  to: string;
  type: 'text' | 'template' | 'image' | 'video' | 'document' | 'audio';
  text?: {
    body: string;
    preview_url?: boolean;
  };
  template?: {
    name: string;
    language: string;
    components?: any[];
  };
  image?: {
    link?: string;
    id?: string;
    caption?: string;
  };
  video?: {
    link?: string;
    id?: string;
    caption?: string;
  };
  document?: {
    link?: string;
    id?: string;
    caption?: string;
    filename?: string;
  };
  audio?: {
    link?: string;
    id?: string;
  };
  context?: {
    message_id: string;
  };
}
