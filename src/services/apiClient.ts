import type { WhatsAppTemplate } from '../types';

/**
 * Cliente HTTP para o backend local. Usa caminhos relativos `/api/*`,
 * que são proxiados pelo Vite em dev (vite.config.ts) para o servidor
 * Express. Em produção o frontend deve ser servido junto do backend
 * ou ter o proxy reverso apontando o mesmo prefixo.
 */

export interface SendMessageRequest {
  phone: string;
  templateName: string;
  language?: string;
  variables?: Record<string, string>;
}

export interface SendMessageResponse {
  success: boolean;
  phone: string;
  messageId?: string;
  error?: string;
}

export interface ListTemplatesResponse {
  provider: string;
  templates: WhatsAppTemplate[];
}

export type TemplateButtonType = 'QUICK_REPLY' | 'URL' | 'PHONE_NUMBER';

export interface TemplateButtonInput {
  type: TemplateButtonType;
  text: string;
  url?: string;
  urlExample?: string;
  phoneNumber?: string;
}

export interface CreateTemplateRequest {
  name: string;
  category: 'MARKETING' | 'UTILITY';
  language?: string;
  header?: string;
  headerExamples?: string[];
  body: string;
  bodyExamples?: string[];
  footer?: string;
  buttons?: TemplateButtonInput[];
}

export interface CreateTemplateResponse {
  success: boolean;
  template?: {
    id: string | null;
    status: string;
    category: string;
  };
  error?: string;
}

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

export const apiClient = {
  async listTemplates(): Promise<ListTemplatesResponse> {
    return jsonFetch<ListTemplatesResponse>('/api/templates');
  },

  async sendMessage(payload: SendMessageRequest): Promise<SendMessageResponse> {
    try {
      return await jsonFetch<SendMessageResponse>('/api/send-message', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
    } catch (err) {
      return {
        success: false,
        phone: payload.phone,
        error: err instanceof Error ? err.message : 'Erro desconhecido',
      };
    }
  },

  async createTemplate(payload: CreateTemplateRequest): Promise<CreateTemplateResponse> {
    return jsonFetch<CreateTemplateResponse>('/api/templates', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },
};
