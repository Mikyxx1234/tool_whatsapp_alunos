import { useCallback, useEffect, useRef, useState } from 'react';
import { X, Paperclip, Loader2, ChevronDown } from 'lucide-react';
import {
  manualOutcomesApi,
  type ManualOutcomeCreateInput,
  type OutcomeKind,
} from '../services/manualOutcomesApi';
import type { ActivationCategory } from '../services/activationApi';
import { useConsultor } from '../hooks/useConsultor';

interface Prefill {
  category?: ActivationCategory;
  rgm?: string;
  cpf?: string;
  nome?: string;
}

interface Props {
  isOpen: boolean;
  prefill?: Prefill;
  onClose: () => void;
  onSaved?: () => void;
}

const CATEGORY_LABELS: Record<ActivationCategory, string> = {
  'docs-pendentes': 'Docs pendentes',
  financeiro: 'Financeiro',
  'acessos-blackboard': 'Blackboard',
  'processos-caa': 'Processo CAA',
  'provavel-evasao': 'Provável evasão',
  'aguardando-inicio': 'Aguardando início',
};

const OUTCOME_LABELS: Record<OutcomeKind, string> = {
  revertido: 'Revertido (manteve matrícula)',
  confirmado: 'Confirmado (cancelamento concluído)',
  sem_contato: 'Sem contato',
  outro: 'Outro',
};

const CATEGORIES: ActivationCategory[] = [
  'processos-caa',
  'docs-pendentes',
  'financeiro',
  'acessos-blackboard',
  'provavel-evasao',
  'aguardando-inicio',
];

const OUTCOMES: OutcomeKind[] = ['revertido', 'confirmado', 'sem_contato', 'outro'];

const ACCEPTED_MIMES = 'image/png,image/jpeg,image/webp,image/gif,application/pdf';

function toLocalDatetimeString(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function ManualOutcomeModal({ isOpen, prefill, onClose, onSaved }: Props) {
  const { name: consultorName } = useConsultor();

  const [category, setCategory] = useState<ActivationCategory>('processos-caa');
  const [rgm, setRgm] = useState('');
  const [nome, setNome] = useState('');
  const [outcome, setOutcome] = useState<OutcomeKind>('revertido');
  const [motivo, setMotivo] = useState('');
  const [notes, setNotes] = useState('');
  const [consultor, setConsultor] = useState('');
  const [occurredAt, setOccurredAt] = useState('');
  const [file, setFile] = useState<File | null>(null);

  const [protocols, setProtocols] = useState<string[]>([]);
  const [protocolo, setProtocolo] = useState('');
  const [protocolLocked, setProtocolLocked] = useState(false);
  const [loadingProtocols, setLoadingProtocols] = useState(false);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const resetForm = useCallback(() => {
    setCategory(prefill?.category ?? 'processos-caa');
    setRgm(prefill?.rgm ?? '');
    setNome(prefill?.nome ?? '');
    setOutcome('revertido');
    setMotivo('');
    setNotes('');
    setConsultor(consultorName);
    setOccurredAt(toLocalDatetimeString(new Date()));
    setFile(null);
    setProtocols([]);
    setProtocolo('');
    setProtocolLocked(false);
    setError(null);
  }, [prefill, consultorName]);

  useEffect(() => {
    if (isOpen) resetForm();
  }, [isOpen, resetForm]);

  const fetchProtocols = useCallback(async (rgmVal: string, cat: ActivationCategory) => {
    if (cat !== 'processos-caa' || !rgmVal.trim()) {
      setProtocols([]);
      setProtocolo('');
      setProtocolLocked(false);
      return;
    }
    setLoadingProtocols(true);
    try {
      const { protocols: list } = await manualOutcomesApi.protocolsByRgm(rgmVal.trim());
      setProtocols(list);
      if (list.length === 1) {
        setProtocolo(list[0]);
        setProtocolLocked(true);
      } else if (list.length > 1) {
        setProtocolo(list[0]);
        setProtocolLocked(false);
      } else {
        setProtocolo('');
        setProtocolLocked(false);
      }
    } catch {
      setProtocols([]);
      setProtocolo('');
    } finally {
      setLoadingProtocols(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen && prefill?.rgm && prefill?.category === 'processos-caa') {
      void fetchProtocols(prefill.rgm, 'processos-caa');
    }
  }, [isOpen, prefill, fetchProtocols]);

  const handleRgmBlur = () => {
    if (category === 'processos-caa') void fetchProtocols(rgm, category);
  };

  const handleCategoryChange = (cat: ActivationCategory) => {
    setCategory(cat);
    if (cat !== 'processos-caa') {
      setProtocols([]);
      setProtocolo('');
      setProtocolLocked(false);
    } else if (rgm.trim()) {
      void fetchProtocols(rgm, cat);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] ?? null;
    if (f && f.size > 10 * 1024 * 1024) {
      setError('Arquivo muito grande. Máximo: 10 MB.');
      return;
    }
    setFile(f);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!rgm.trim()) {
      setError('RGM é obrigatório.');
      return;
    }
    if (!consultor.trim()) {
      setError('Nome do consultor é obrigatório.');
      return;
    }

    setSaving(true);
    try {
      const input: ManualOutcomeCreateInput = {
        category,
        rgm: rgm.trim() || undefined,
        nome: nome.trim() || undefined,
        protocolo: protocolo.trim() || undefined,
        outcome,
        motivo: motivo.trim() || undefined,
        notes: notes.trim() || undefined,
        consultor_nome: consultor.trim(),
        occurred_at: occurredAt ? new Date(occurredAt).toISOString() : undefined,
      };

      const { outcome: saved } = await manualOutcomesApi.create(input);

      if (file) {
        await manualOutcomesApi.uploadProof(saved.id, file);
      }

      onSaved?.();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao salvar');
    } finally {
      setSaving(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-lg p-6 max-h-[90vh] overflow-y-auto">
        <button
          type="button"
          onClick={onClose}
          className="absolute top-4 right-4 p-1.5 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100 transition-colors"
          aria-label="Fechar"
        >
          <X className="w-5 h-5" />
        </button>

        <h3 className="text-lg font-semibold text-gray-900 mb-4">Registrar desfecho</h3>

        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Categoria</label>
              <div className="relative">
                <select
                  value={category}
                  onChange={(e) => handleCategoryChange(e.target.value as ActivationCategory)}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm appearance-none pr-8 focus:outline-none focus:ring-2 focus:ring-whatsapp-500"
                  disabled={Boolean(prefill?.category)}
                >
                  {CATEGORIES.map((c) => (
                    <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>
                  ))}
                </select>
                <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Desfecho <span className="text-rose-500">*</span></label>
              <div className="relative">
                <select
                  value={outcome}
                  onChange={(e) => setOutcome(e.target.value as OutcomeKind)}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm appearance-none pr-8 focus:outline-none focus:ring-2 focus:ring-whatsapp-500"
                  required
                >
                  {OUTCOMES.map((o) => (
                    <option key={o} value={o}>{OUTCOME_LABELS[o]}</option>
                  ))}
                </select>
                <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">RGM <span className="text-rose-500">*</span></label>
              <input
                type="text"
                value={rgm}
                onChange={(e) => setRgm(e.target.value)}
                onBlur={handleRgmBlur}
                placeholder="Ex.: 47485892"
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-whatsapp-500"
                disabled={Boolean(prefill?.rgm)}
                required
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Nome do aluno</label>
              <input
                type="text"
                value={nome}
                onChange={(e) => setNome(e.target.value)}
                placeholder="Nome completo"
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-whatsapp-500"
                disabled={Boolean(prefill?.nome)}
              />
            </div>
          </div>

          {category === 'processos-caa' && (
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Protocolo
                {loadingProtocols && <span className="ml-1 text-gray-400">(buscando…)</span>}
              </label>
              {protocols.length > 1 ? (
                <div className="relative">
                  <select
                    value={protocolo}
                    onChange={(e) => setProtocolo(e.target.value)}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm appearance-none pr-8 focus:outline-none focus:ring-2 focus:ring-whatsapp-500"
                  >
                    <option value="">— sem protocolo —</option>
                    {protocols.map((p) => (
                      <option key={p} value={p}>{p}</option>
                    ))}
                  </select>
                  <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
                </div>
              ) : (
                <div className="flex gap-2 items-center">
                  <input
                    type="text"
                    value={protocolo}
                    onChange={(e) => setProtocolo(e.target.value)}
                    placeholder="Número do protocolo"
                    readOnly={protocolLocked}
                    className={`flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-whatsapp-500 ${protocolLocked ? 'bg-gray-50 text-gray-600' : ''}`}
                  />
                  {protocolLocked && (
                    <button
                      type="button"
                      onClick={() => { setProtocolLocked(false); setProtocolo(''); }}
                      className="text-xs text-whatsapp-700 hover:underline shrink-0"
                    >
                      Trocar
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Motivo / Observação rápida</label>
            <input
              type="text"
              value={motivo}
              onChange={(e) => setMotivo(e.target.value)}
              placeholder="Ex.: Aluno solicitou desistência da solicitação"
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-whatsapp-500"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Notas detalhadas</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder="Detalhes adicionais sobre o atendimento…"
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-whatsapp-500 resize-none"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Consultor <span className="text-rose-500">*</span></label>
              <input
                type="text"
                value={consultor}
                onChange={(e) => setConsultor(e.target.value)}
                placeholder="Seu nome"
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-whatsapp-500"
                required
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Data/hora</label>
              <input
                type="datetime-local"
                value={occurredAt}
                onChange={(e) => setOccurredAt(e.target.value)}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-whatsapp-500"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Anexo (print da conversa)</label>
            <div
              className="border border-dashed border-gray-300 rounded-lg px-3 py-3 flex items-center gap-2 cursor-pointer hover:border-whatsapp-400 transition-colors"
              onClick={() => fileInputRef.current?.click()}
            >
              <Paperclip className="w-4 h-4 text-gray-400 shrink-0" />
              <span className="text-sm text-gray-500 truncate">
                {file ? file.name : 'Clique para selecionar PNG, JPG, GIF, WebP ou PDF (máx. 10 MB)'}
              </span>
              {file && (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); setFile(null); if (fileInputRef.current) fileInputRef.current.value = ''; }}
                  className="ml-auto text-gray-400 hover:text-gray-600 shrink-0"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPTED_MIMES}
              className="hidden"
              onChange={handleFileChange}
            />
          </div>

          {error && (
            <div className="text-xs text-rose-700 bg-rose-50 border border-rose-100 rounded-lg px-3 py-2">
              {error}
            </div>
          )}

          <div className="flex gap-3 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2.5 text-sm font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={saving}
              className="flex-1 px-4 py-2.5 text-sm font-medium text-white bg-whatsapp-500 hover:bg-whatsapp-600 rounded-lg transition-colors disabled:opacity-60 inline-flex items-center justify-center gap-2"
            >
              {saving && <Loader2 className="w-4 h-4 animate-spin" />}
              {saving ? 'Salvando…' : 'Registrar'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
