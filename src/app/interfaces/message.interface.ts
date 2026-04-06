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


export interface SendBulkMessageDto {
  company_id: string;
  messageUUID: string;
  campaign_id: string | undefined | null;
  phone_number_id: string;
  to: string;
  type: 'text' | 'template' | 'image' | 'video' | 'document' | 'audio' | 'interactive' | 'location' | 'contacts' | 'sticker' | 'reaction';
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
  interactive?: {
    type: 'list' | 'button' | 'product' | 'product_list';
    header?: {
      type: 'text' | 'video' | 'image' | 'document';
      text?: string;
      video?: { id?: string; link?: string };
      image?: { id?: string; link?: string };
      document?: { id?: string; link?: string };
    };
    body?: {
      text: string;
    };
    footer?: {
      text: string;
    };
    action: any;
  };
  location?: {
    longitude: number;
    latitude: number;
    name?: string;
    address?: string;
  };
  contacts?: any[];
  sticker?: {
    link?: string;
    id?: string;
  };
  reaction?: {
    message_id: string;
    emoji: string;
  };
  context?: {
    message_id: string;
  };
}

export interface SendMessageDto {
  user_id:string;
  messageUUID?: string;
  campaign_id: string | undefined | null;
  phone_number_id: string;
  profile_name?: string;
  to: string;
  type: 'text' | 'template' | 'image' | 'video' | 'document' | 'audio' | 'interactive' | 'location' | 'contacts' | 'sticker' | 'reaction';
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
  interactive?: {
    type: 'list' | 'button' | 'product' | 'product_list';
    header?: {
      type: 'text' | 'video' | 'image' | 'document';
      text?: string;
      video?: { id?: string; link?: string };
      image?: { id?: string; link?: string };
      document?: { id?: string; link?: string };
    };
    body?: {
      text: string;
    };
    footer?: {
      text: string;
    };
    action: any;
  };
  location?: {
    longitude: number;
    latitude: number;
    name?: string;
    address?: string;
  };
  contacts?: any[];
  sticker?: {
    link?: string;
    id?: string;
  };
  reaction?: {
    message_id: string;
    emoji: string;
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
  user_id: string;
  phone_number_id: string;
  messageUUID: string;
  to: string;
  type: 'text' | 'template' | 'image' | 'video' | 'document' | 'audio' | 'interactive' | 'location' | 'contacts' | 'sticker' | 'reaction';
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
  interactive?: {
    type: 'list' | 'button' | 'product' | 'product_list';
    header?: {
      type: 'text' | 'video' | 'image' | 'document';
      text?: string;
      video?: { id?: string; link?: string };
      image?: { id?: string; link?: string };
      document?: { id?: string; link?: string };
    };
    body?: {
      text: string;
    };
    footer?: {
      text: string;
    };
    action: any;
  };
  location?: {
    longitude: number;
    latitude: number;
    name?: string;
    address?: string;
  };
  contacts?: any[];
  sticker?: {
    link?: string;
    id?: string;
  };
  reaction?: {
    message_id: string;
    emoji: string;
  };
  context?: {
    message_id: string;
  };
}