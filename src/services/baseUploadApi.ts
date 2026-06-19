import type { ReportSlug } from './reportApi';
import { apiAuthHeaders } from './apiAuth';
import { fetchJson } from './httpJson';

export type RematriculaSource = 'siaa' | 'portal-de-polos';

export interface BaseSnapshotDto {
  id: string;
  file_name: string;
  file_size_bytes: number | null;
  row_count: number;
  created_at: string;
  source?: RematriculaSource;
}

export interface RematriculaBaseStatus {
  ok?: boolean;
  active_source: RematriculaSource | null;
  active_snapshot: BaseSnapshotDto | null;
  active_row_count: number;
  siaa: BaseSnapshotDto | null;
  portal_de_polos: BaseSnapshotDto | null;
}

export const baseUploadApi = {
  listSnapshots(category: ReportSlug) {
    return fetchJson<{ snapshots: BaseSnapshotDto[] }>(
      `/api/base-uploads/${category}/snapshots`,
      { timeoutMs: 60_000 }
    );
  },

  uploadCsv(
    category: ReportSlug,
    payload: { fileName: string; csvText: string; fileSizeBytes?: number }
  ) {
    return fetchJson<{ snapshot: BaseSnapshotDto; rowCount: number; warning?: string | null }>(
      `/api/base-uploads/${category}/upload`,
      {
        method: 'POST',
        timeoutMs: 900_000,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }
    );
  },

  /** Planilhas grandes: envia XLSX/CSV binário; o servidor converte (mais rápido que CSV no browser). */
  async uploadFile(category: ReportSlug, file: File) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 900_000);
    try {
      const response = await fetch(`/api/base-uploads/${category}/upload-file`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/octet-stream',
          'X-File-Name': encodeURIComponent(file.name),
          ...apiAuthHeaders(),
        },
        body: file,
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
          `Importação falhou (${response.status})`;
        throw new Error(message);
      }
      return data as { snapshot: BaseSnapshotDto; rowCount: number; warning?: string | null };
    } finally {
      window.clearTimeout(timer);
    }
  },

  deleteSnapshot(category: ReportSlug, snapshotId: string) {
    return fetchJson<{ ok: boolean }>(
      `/api/base-uploads/${category}/snapshots/${snapshotId}`,
      { method: 'DELETE', timeoutMs: 60_000 }
    );
  },

  getRematriculaStatus() {
    return fetchJson<RematriculaBaseStatus>('/api/base-uploads/rematricula/status', {
      timeoutMs: 60_000,
    });
  },

  async uploadRematriculaFile(source: RematriculaSource, file: File) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 900_000);
    try {
      const response = await fetch('/api/base-uploads/rematricula/upload-file', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/octet-stream',
          'X-File-Name': encodeURIComponent(file.name),
          'X-Remat-Source': source,
          ...apiAuthHeaders(),
        },
        body: file,
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
          `Importação falhou (${response.status})`;
        throw new Error(message);
      }
      return data as { snapshot: BaseSnapshotDto; rowCount: number; warning?: string | null };
    } finally {
      window.clearTimeout(timer);
    }
  },
};
