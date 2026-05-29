import type {
  CampaignContactDB,
  CampaignSummaryDB,
  CampaignType,
  Contact,
} from '../types';

async function jsonFetch<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    ...init,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  });
  const text = await response.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    const message =
      (data as { error?: string })?.error ||
      `Requisição para ${input} falhou (${response.status})`;
    throw new Error(message);
  }
  return data as T;
}

export interface CreateCampaignInput {
  name: string;
  description?: string;
  campaignTypeCode: string;
  templateName: string;
  templateLanguage?: string;
  templateCategory?: string;
  sourceFileName?: string;
  intervalSeconds?: number;
  dailyLimit?: number;
  createdBy?: string;
}

export type CampaignDB = CampaignSummaryDB;

/** Converte um Contact local para o formato esperado pelo POST /campaigns/:id/contacts. */
export function toApiContact(contact: Contact) {
  return {
    phone: contact.rawPhone,
    normalizedPhone: contact.phone,
    name: contact.name,
    email: contact.email,
    course: contact.curso,
    origem: contact.origem,
    studentId: contact.extras?.student_id || contact.extras?.studentid,
    cpf: contact.extras?.cpf,
    rawData: contact.extras,
    validationStatus: contact.status === 'valid' || contact.status === 'pending'
      ? contact.status === 'valid'
        ? 'valid'
        : 'pending'
      : contact.status === 'invalid'
      ? 'invalid'
      : contact.status === 'duplicate'
      ? 'duplicate'
      : 'pending',
    errorMessage: contact.errorMessage,
  };
}

export const campaignApi = {
  async listTypes(): Promise<CampaignType[]> {
    const r = await jsonFetch<{ campaignTypes: CampaignType[] }>('/api/campaign-types');
    return r.campaignTypes;
  },

  async list(params?: { status?: string; type?: string }): Promise<CampaignDB[]> {
    const qs = new URLSearchParams();
    if (params?.status) qs.set('status', params.status);
    if (params?.type) qs.set('type', params.type);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    const r = await jsonFetch<{ campaigns: CampaignDB[] }>(`/api/campaigns${suffix}`);
    return r.campaigns;
  },

  async create(input: CreateCampaignInput): Promise<CampaignDB> {
    const r = await jsonFetch<{ campaign: CampaignDB }>('/api/campaigns', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    return r.campaign;
  },

  async get(id: string): Promise<CampaignDB> {
    const r = await jsonFetch<{ campaign: CampaignDB }>(`/api/campaigns/${id}`);
    return r.campaign;
  },

  async addContacts(
    campaignId: string,
    contacts: ReturnType<typeof toApiContact>[],
    sourceFileName?: string
  ) {
    return jsonFetch<{ insertedCount: number; campaign: CampaignDB }>(
      `/api/campaigns/${campaignId}/contacts`,
      {
        method: 'POST',
        body: JSON.stringify({ contacts, sourceFileName }),
      }
    );
  },

  async listContacts(
    campaignId: string,
    params?: { status?: string; limit?: number }
  ): Promise<CampaignContactDB[]> {
    const qs = new URLSearchParams();
    if (params?.status) qs.set('status', params.status);
    if (params?.limit) qs.set('limit', String(params.limit));
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    const r = await jsonFetch<{ contacts: CampaignContactDB[] }>(
      `/api/campaigns/${campaignId}/contacts${suffix}`
    );
    return r.contacts;
  },

  async start(
    campaignId: string,
    options?: { intervalSeconds?: number; dailyLimit?: number }
  ) {
    return jsonFetch<{ campaignId: string; status: string }>(
      `/api/campaigns/${campaignId}/start`,
      {
        method: 'POST',
        body: JSON.stringify(options || {}),
      }
    );
  },

  async pause(campaignId: string) {
    return jsonFetch(`/api/campaigns/${campaignId}/pause`, { method: 'POST' });
  },

  async cancel(campaignId: string) {
    return jsonFetch(`/api/campaigns/${campaignId}/cancel`, { method: 'POST' });
  },

  async markNotInteracted(campaignId: string, hoursAfterSend = 24) {
    return jsonFetch<{ updated: number }>(
      `/api/campaigns/${campaignId}/mark-not-interacted`,
      {
        method: 'POST',
        body: JSON.stringify({ hoursAfterSend }),
      }
    );
  },

  async getExportCounts(campaignId: string): Promise<ExportCounts> {
    const r = await jsonFetch<{ counts: ExportCounts }>(
      `/api/campaigns/${campaignId}/export-counts`
    );
    return r.counts;
  },

  exportContactsUrl(campaignId: string, categories: ExportCategory[]): string {
    const cats = categories.join(',');
    return `/api/campaigns/${campaignId}/contacts/export?categories=${encodeURIComponent(
      cats
    )}`;
  },

  async downloadExport(
    campaignId: string,
    categories: ExportCategory[],
    fileName: string
  ): Promise<void> {
    const url = campaignApi.exportContactsUrl(campaignId, categories);
    const response = await fetch(url);
    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || `Falha ao exportar (${response.status})`);
    }
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(objectUrl);
  },
};

export type ExportCategory =
  | 'failed'
  | 'invalid'
  | 'duplicate'
  | 'not_on_whatsapp'
  | 'sent'
  | 'pending';

export interface ExportCounts {
  invalid: number;
  duplicate: number;
  failed: number;
  not_on_whatsapp: number;
  sent: number;
}
