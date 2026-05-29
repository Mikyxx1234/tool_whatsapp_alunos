import { useCallback, useEffect, useState } from 'react';
import { Download, Trash2, Upload, FileSpreadsheet } from 'lucide-react';
import { v4 as uuid } from 'uuid';
import { Header } from '../components/Header';
import { Toast, type ToastVariant } from '../components/Toast';
import { fileToCsvText, isSupportedFile } from '../utils/fileToCsvText';
import type { ReportSlug } from '../services/reportApi';

const LEGACY_STORAGE_KEY = 'disparador_upload_bases_v1';
const STORAGE_KEY = 'disparador_upload_bases_v2';

const SECTIONS: { id: ReportSlug; title: string; hint: string }[] = [
  {
    id: 'matriculados',
    title: 'Matriculados',
    hint: 'Listas de alunos matriculados (CSV/XLSX normalizado como CSV).',
  },
  {
    id: 'docs-pendentes',
    title: 'Alunos docs. pendentes',
    hint: 'Base para pendências de documentação.',
  },
  {
    id: 'financeiro',
    title: 'Financeiro',
    hint: 'Base financeira / inadimplência / boletos.',
  },
  {
    id: 'acessos-blackboard',
    title: 'Acessos Blackboard',
    hint: 'Exportações de acesso ou uso do Blackboard.',
  },
  {
    id: 'processos-caa',
    title: 'Processos CAA',
    hint: 'Protocolos e status do CAA.',
  },
];

interface SavedBase {
  id: string;
  name: string;
  size: number;
  lineCount: number;
  uploadedAt: string;
  csvText: string;
}

type BasesByCategory = Record<ReportSlug, SavedBase[]>;

function emptyStore(): BasesByCategory {
  return {
    matriculados: [],
    'docs-pendentes': [],
    financeiro: [],
    'acessos-blackboard': [],
    'processos-caa': [],
  };
}

function isValidSavedBase(x: unknown): x is SavedBase {
  return (
    typeof x === 'object' &&
    x !== null &&
    typeof (x as SavedBase).id === 'string' &&
    typeof (x as SavedBase).name === 'string' &&
    typeof (x as SavedBase).csvText === 'string'
  );
}

function countDataLines(csvText: string): number {
  const t = csvText.trim();
  if (!t) return 0;
  return t.split(/\r?\n/).length;
}

function loadStored(): BasesByCategory {
  const empty = emptyStore();
  try {
    const v2 = localStorage.getItem(STORAGE_KEY);
    if (v2) {
      const parsed = JSON.parse(v2) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const { id } of SECTIONS) {
          const arr = (parsed as Record<string, unknown>)[id];
          if (Array.isArray(arr)) {
            empty[id] = arr.filter(isValidSavedBase);
          }
        }
        return empty;
      }
    }
    const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (legacy) {
      const parsed = JSON.parse(legacy) as unknown;
      if (Array.isArray(parsed)) {
        empty.matriculados = parsed.filter(isValidSavedBase);
      }
    }
  } catch {
    /* ignore */
  }
  return empty;
}

function tryPersist(store: BasesByCategory): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
    return true;
  } catch {
    return false;
  }
}

interface ToastState {
  message: string;
  variant: ToastVariant;
  visible: boolean;
}

export default function BasesPage() {
  const [store, setStore] = useState<BasesByCategory>(() => emptyStore());
  const [hydrated, setHydrated] = useState(false);
  const [busy, setBusy] = useState<Partial<Record<ReportSlug, boolean>>>({});
  const [toast, setToast] = useState<ToastState>({
    message: '',
    variant: 'success',
    visible: false,
  });

  const showToast = useCallback((message: string, variant: ToastVariant = 'success') => {
    setToast({ message, variant, visible: true });
  }, []);

  useEffect(() => {
    setStore(loadStored());
    setHydrated(true);
  }, []);

  const ingestFiles = useCallback(
    async (fileList: FileList | File[], category: ReportSlug) => {
      const files = Array.from(fileList).filter((f) => isSupportedFile(f));
      if (!files.length) {
        showToast('Nenhum arquivo CSV ou XLSX válido selecionado.', 'error');
        return;
      }
      setBusy((b) => ({ ...b, [category]: true }));
      try {
        const additions: SavedBase[] = [];
        for (const file of files) {
          const csvText = await fileToCsvText(file);
          additions.push({
            id: uuid(),
            name: file.name,
            size: file.size,
            lineCount: countDataLines(csvText),
            uploadedAt: new Date().toISOString(),
            csvText,
          });
        }
        let persisted = false;
        setStore((prev) => {
          const next: BasesByCategory = {
            ...prev,
            [category]: [...additions, ...(prev[category] || [])],
          };
          persisted = tryPersist(next);
          return persisted ? next : prev;
        });
        if (!persisted) {
          showToast(
            'Não foi possível salvar (armazenamento cheio ou indisponível). Remova arquivos ou use bases menores.',
            'error'
          );
          return;
        }
        const label = SECTIONS.find((s) => s.id === category)?.title ?? category;
        showToast(
          additions.length === 1
            ? `${label}: "${additions[0].name}" salvo (${additions[0].lineCount} linhas).`
            : `${label}: ${additions.length} arquivo(s) salvos.`,
          'success'
        );
      } catch (err) {
        showToast(err instanceof Error ? err.message : 'Erro ao processar arquivo(s).', 'error');
      } finally {
        setBusy((b) => ({ ...b, [category]: false }));
      }
    },
    [showToast]
  );

  const handlePick = useCallback(
    (category: ReportSlug) => {
      if (busy[category]) return;
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.accept =
        '.csv,.xlsx,.xls,.xlsm,.xlsb,.tsv,.txt,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel';
      input.onchange = () => {
        const list = input.files;
        if (list?.length) void ingestFiles(list, category);
      };
      input.click();
    },
    [busy, ingestFiles]
  );

  const removeBase = useCallback(
    (category: ReportSlug, id: string) => {
      setStore((prev) => {
        const next: BasesByCategory = {
          ...prev,
          [category]: (prev[category] || []).filter((b) => b.id !== id),
        };
        if (!tryPersist(next)) {
          showToast('Erro ao atualizar o armazenamento local.', 'error');
          return prev;
        }
        showToast('Arquivo removido.', 'info');
        return next;
      });
    },
    [showToast]
  );

  const downloadBase = useCallback((b: SavedBase) => {
    const blob = new Blob([b.csvText], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const baseName = b.name.replace(/\.[^.]+$/i, '') || 'base';
    a.href = url;
    a.download = `${baseName}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  const totalFiles = SECTIONS.reduce((n, s) => n + (store[s.id]?.length ?? 0), 0);

  return (
    <div className="min-h-screen bg-gray-50">
      <Header showHistoryButton={false} />
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-2xl font-semibold text-gray-900">Bases</h2>
            <p className="text-sm text-gray-500 mt-1 max-w-3xl">
              Cada tipo de base tem seu próprio upload e lista de arquivos. Formatos: CSV ou XLSX
              (convertidos para CSV neste navegador). Use para organizar listas antes do disparador
              ou da importação de alunos.
            </p>
          </div>
          {!hydrated ? (
            <span className="text-xs text-gray-400">Carregando…</span>
          ) : (
            <span className="text-xs text-gray-500">{totalFiles} arquivo(s) no total</span>
          )}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          {SECTIONS.map((section) => {
            const list = store[section.id] || [];
            const isBusy = Boolean(busy[section.id]);
            return (
              <section
                key={section.id}
                className="bg-white rounded-2xl border border-gray-100 shadow-sm flex flex-col overflow-hidden"
              >
                <div className="px-4 py-3 border-b border-gray-100 bg-gray-50/80">
                  <h3 className="text-sm font-semibold text-gray-900">{section.title}</h3>
                  <p className="text-xs text-gray-500 mt-0.5">{section.hint}</p>
                </div>

                <div className="p-4 flex flex-col gap-3 flex-1 min-h-0">
                  <div
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        handlePick(section.id);
                      }
                    }}
                    onDragOver={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      if (isBusy) return;
                      void ingestFiles(e.dataTransfer.files, section.id);
                    }}
                    onClick={() => handlePick(section.id)}
                    className={`rounded-xl border-2 border-dashed border-gray-200 p-5 text-center cursor-pointer transition-all flex-shrink-0 ${
                      isBusy
                        ? 'opacity-60 pointer-events-none'
                        : 'hover:border-whatsapp-400 hover:bg-emerald-50/30'
                    }`}
                  >
                    <div className="w-11 h-11 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-2">
                      <Upload className="w-5 h-5 text-gray-500" />
                    </div>
                    <p className="text-xs font-medium text-gray-700">
                      {isBusy ? 'Processando…' : 'Arraste arquivos aqui ou clique'}
                    </p>
                    <p className="text-[11px] text-gray-400 mt-0.5">CSV, XLSX, XLS…</p>
                  </div>

                  <div className="flex-1 min-h-[120px] max-h-56 overflow-y-auto rounded-lg border border-gray-100 bg-gray-50/50">
                    {list.length === 0 ? (
                      <p className="text-xs text-gray-500 p-3 text-center">Nenhum arquivo nesta base.</p>
                    ) : (
                      <ul className="divide-y divide-gray-100">
                        {list.map((b) => (
                          <li
                            key={b.id}
                            className="px-3 py-2 flex items-start gap-2 hover:bg-white/80 text-xs"
                          >
                            <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-600 flex-shrink-0 mt-0.5" />
                            <div className="flex-1 min-w-0">
                              <p className="font-medium text-gray-900 truncate" title={b.name}>
                                {b.name}
                              </p>
                              <p className="text-gray-500">
                                {b.lineCount} linhas · {(b.size / 1024).toFixed(1)} KB ·{' '}
                                {new Date(b.uploadedAt).toLocaleString('pt-BR', {
                                  day: '2-digit',
                                  month: '2-digit',
                                  hour: '2-digit',
                                  minute: '2-digit',
                                })}
                              </p>
                            </div>
                            <div className="flex items-center gap-0.5 flex-shrink-0">
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  downloadBase(b);
                                }}
                                className="p-1.5 text-gray-500 hover:text-whatsapp-700 hover:bg-whatsapp-50 rounded-md"
                                title="Baixar CSV"
                              >
                                <Download className="w-3.5 h-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  removeBase(section.id, b.id);
                                }}
                                className="p-1.5 text-gray-500 hover:text-red-600 hover:bg-red-50 rounded-md"
                                title="Remover"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              </section>
            );
          })}
        </div>

        <p className="text-xs text-gray-400">
          Os dados ficam apenas no seu navegador (localStorage). Limpar dados do site apaga as bases.
          Bases antigas (sem categoria) passam a aparecer em <strong>Matriculados</strong>.
        </p>
      </main>

      <Toast
        message={toast.message}
        variant={toast.variant}
        isVisible={toast.visible}
        onClose={() => setToast((t) => ({ ...t, visible: false }))}
      />
    </div>
  );
}
