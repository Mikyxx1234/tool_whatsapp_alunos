export type ContactStatus =
  | 'valid'
  | 'invalid'
  | 'duplicate'
  | 'pending'
  | 'sending'
  | 'sent'
  | 'error';

export interface Contact {
  id: string;
  rawPhone: string;
  phone: string;
  name?: string;
  email?: string;
  curso?: string;
  origem?: string;
  extras: Record<string, string>;
  status: ContactStatus;
  errorMessage?: string;
  messageId?: string;
}

export interface TemplateComponent {
  type: string;
  format?: string;
  text?: string;
  example?: unknown;
  parameters?: unknown[];
  buttons?: unknown[];
}

export interface WhatsAppTemplate {
  id: string;
  name: string;
  language: string;
  status: string;
  category: string;
  components: TemplateComponent[];
}

export interface UploadedFileMeta {
  name: string;
  size: number;
  lines: number;
}

export type CampaignStatusType =
  | 'idle'
  | 'running'
  | 'completed'
  | 'cancelled'
  | 'failed';

export interface CampaignProgress {
  total: number;
  sent: number;
  failed: number;
  pending: number;
  status: CampaignStatusType;
}

export interface StoredCampaign {
  id: string;
  campaignName: string;
  templateName: string;
  createdAt: string;
  total: number;
  sent: number;
  failed: number;
  status: 'concluida' | 'cancelada' | 'com_erros' | 'falhou';
}

export interface CampaignType {
  id: string;
  code: string;
  name: string;
  description?: string | null;
  is_active: boolean;
  created_at: string;
}

/** Linha da view vw_whatsapp_campaign_summary (snake_case do banco). */
export interface CampaignSummaryDB {
  id: string;
  name: string;
  campaign_type: string | null;
  campaign_type_name: string | null;
  template_name: string | null;
  template_language: string | null;
  template_category: string | null;
  status: string;
  total_contacts: number;
  total_valid: number;
  total_invalid: number;
  total_duplicates: number;
  total_sent: number;
  total_failed: number;
  total_interacted: number;
  total_not_interacted: number;
  taxa_envio: number;
  taxa_interacao: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface CampaignContactDB {
  id: string;
  campaign_id: string;
  phone: string;
  normalized_phone: string;
  name: string | null;
  email: string | null;
  course: string | null;
  origem: string | null;
  validation_status: 'pending' | 'valid' | 'invalid' | 'duplicate';
  send_status:
    | 'pending'
    | 'queued'
    | 'sending'
    | 'sent'
    | 'failed'
    | 'skipped'
    | 'cancelled';
  interaction_status: 'unknown' | 'interacted' | 'not_interacted';
  error_message: string | null;
  sent_at: string | null;
  first_interaction_at: string | null;
  last_interaction_at: string | null;
}
