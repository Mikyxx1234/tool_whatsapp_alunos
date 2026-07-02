import { apiAuthHeaders } from './apiAuth';
import { getConsultoresCatalogo, readConsultorIdentity } from './meuPainelApi';

export interface ConsultorMetaRow {
  id: string;
  consultor_nome: string;
  ano_mes: string;
  meta_marcados: number;
  created_at?: string;
  updated_at?: string;
}

function authBody(extra: Record<string, unknown> = {}) {
  const id = readConsultorIdentity();
  return {
    ...extra,
    role: id.role,
    categoria: id.categoria,
  };
}

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...apiAuthHeaders(),
      ...(init?.headers || {}),
    },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error || 'Erro na requisição');
  return data as T;
}

export interface ConsultorMetaCatalogoRow {
  username: string | null;
  nome: string;
  origem: 'crm' | 'banco';
  tem_meta: boolean;
  meta_marcados: number | null;
  meta_id: string | null;
}

export const consultorMetasApi = {
  async listConsultores(
    ano_mes: string,
    catalogo: Array<{ username?: string | null; nome: string }>
  ): Promise<ConsultorMetaCatalogoRow[]> {
    const id = readConsultorIdentity();
    const r = await jsonFetch<{ consultores: ConsultorMetaCatalogoRow[] }>(
      '/api/consultor-metas/consultores',
      {
        method: 'POST',
        body: JSON.stringify({
          ano_mes,
          catalogo,
          role: id.role,
          categoria: id.categoria,
        }),
      }
    );
    return r.consultores;
  },

  async list(ano_mes?: string): Promise<ConsultorMetaRow[]> {
    const id = readConsultorIdentity();
    const p = new URLSearchParams();
    if (id.role) p.set('role', id.role);
    if (id.categoria) p.set('categoria', id.categoria);
    if (ano_mes) p.set('ano_mes', ano_mes);
    const qs = p.toString();
    const r = await jsonFetch<{ items: ConsultorMetaRow[] }>(
      `/api/consultor-metas${qs ? `?${qs}` : ''}`
    );
    return r.items;
  },

  async upsert(payload: {
    consultor_nome: string;
    ano_mes: string;
    meta_marcados: number;
    catalogo?: Array<{ username?: string | null; nome: string }>;
  }): Promise<ConsultorMetaRow> {
    const catalogo = payload.catalogo ?? getConsultoresCatalogo();
    const r = await jsonFetch<{ row: ConsultorMetaRow }>('/api/consultor-metas', {
      method: 'POST',
      body: JSON.stringify(authBody({ ...payload, catalogo })),
    });
    return r.row;
  },

  async remove(id: string): Promise<void> {
    const idn = readConsultorIdentity();
    const p = new URLSearchParams();
    if (idn.role) p.set('role', idn.role);
    if (idn.categoria) p.set('categoria', idn.categoria);
    await jsonFetch(`/api/consultor-metas/${id}?${p}`, { method: 'DELETE' });
  },
};
