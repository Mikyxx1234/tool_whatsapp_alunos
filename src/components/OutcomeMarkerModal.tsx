import { useEffect, useState } from 'react';
import { X, CheckCircle, XCircle, PhoneOff, HelpCircle } from 'lucide-react';
import {
  type OutcomeKind,
  type MeuPainelItem,
  OUTCOME_LABEL,
  getMeuPainelBaseLabel,
  createOutcome,
  canFillRgmForLead,
  readConsultorIdentity,
} from '../services/meuPainelApi';

interface Props {
  open: boolean;
  item: MeuPainelItem | null;
  consultorNome: string;
  onClose: () => void;
  onSaved: () => void;
}

const OUTCOME_BUTTONS: Array<{
  kind: OutcomeKind;
  Icon: typeof CheckCircle;
  tone: string;
  toneActive: string;
}> = [
  {
    kind: 'revertido',
    Icon: CheckCircle,
    tone: 'border-emerald-200 hover:bg-emerald-50 text-emerald-700',
    toneActive: 'border-emerald-500 bg-emerald-50 text-emerald-800 ring-2 ring-emerald-200',
  },
  {
    kind: 'confirmado',
    Icon: XCircle,
    tone: 'border-rose-200 hover:bg-rose-50 text-rose-700',
    toneActive: 'border-rose-500 bg-rose-50 text-rose-800 ring-2 ring-rose-200',
  },
  {
    kind: 'sem_contato',
    Icon: PhoneOff,
    tone: 'border-amber-200 hover:bg-amber-50 text-amber-700',
    toneActive: 'border-amber-500 bg-amber-50 text-amber-800 ring-2 ring-amber-200',
  },
  {
    kind: 'outro',
    Icon: HelpCircle,
    tone: 'border-gray-200 hover:bg-gray-50 text-gray-700',
    toneActive: 'border-gray-500 bg-gray-50 text-gray-800 ring-2 ring-gray-200',
  },
];

export function OutcomeMarkerModal({ open, item, consultorNome, onClose, onSaved }: Props) {
  const [outcome, setOutcome] = useState<OutcomeKind | null>(null);
  const [motivo, setMotivo] = useState('');
  const [notes, setNotes] = useState('');
  const [rgmInput, setRgmInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const identity = readConsultorIdentity();
  const canFillRgm = item ? canFillRgmForLead(item, identity) : false;

  useEffect(() => {
    if (open && item) {
      setOutcome((item.outcome as OutcomeKind | null) ?? null);
      setMotivo(item.outcome_motivo ?? '');
      setNotes(item.outcome_notes ?? '');
      setRgmInput('');
      setError(null);
    }
  }, [open, item]);

  if (!open || !item) return null;

  async function handleSave() {
    if (!outcome) {
      setError('Selecione um desfecho.');
      return;
    }
    if (!item) return;

    const rgmToSave = canFillRgm ? rgmInput.trim() : (item.rgm || '').trim();
    if (canFillRgm && !rgmToSave) {
      setError('Informe o RGM do aluno para salvar a marcação.');
      return;
    }
    if (!canFillRgm && !rgmToSave && !item.master_key) {
      setError('Este lead não possui RGM. Somente o consultor responsável pode preencher.');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await createOutcome({
        category: item.category,
        rgm: rgmToSave || null,
        cpf: item.cpf,
        nome: item.nome,
        protocolo: item.protocolo,
        master_key: rgmToSave ? `RGM:${rgmToSave}` : item.master_key,
        response_id: item.response_id,
        outcome,
        motivo: motivo.trim() || null,
        notes: notes.trim() || null,
        consultor_nome: consultorNome,
        role: identity.role,
        categoria: identity.categoria,
      });
      onSaved();
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Erro ao salvar';
      setError(msg);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-gray-900/60 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl border border-gray-100 shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-gray-100 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-gray-500">
              Marcar desfecho · {getMeuPainelBaseLabel(item.category, item.origem_ativacao)}
            </p>
            <h2 className="text-lg font-semibold text-gray-900 truncate" title={item.nome || ''}>
              {item.nome || '(sem nome)'}
            </h2>
            <p className="text-xs text-gray-500 mt-0.5">
              {item.rgm ? (
                <>RGM {item.rgm}</>
              ) : (
                <>RGM não informado</>
              )}
              {item.protocolo ? <> · Protocolo {item.protocolo}</> : null}
              {item.telefone ? <> · {item.telefone}</> : null}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-md text-gray-400 hover:text-gray-700 hover:bg-gray-50"
            aria-label="Fechar"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-5">
          {canFillRgm && (
            <div>
              <label htmlFor="outcome-rgm" className="text-xs font-semibold text-gray-700 mb-1.5 block">
                RGM <span className="text-rose-600">*</span>
              </label>
              <input
                id="outcome-rgm"
                type="text"
                inputMode="numeric"
                value={rgmInput}
                onChange={(e) => setRgmInput(e.target.value.replace(/[^\d]/g, ''))}
                maxLength={12}
                placeholder="Ex.: 49340671"
                className="input font-mono"
                autoFocus
              />
              <p className="text-[11px] text-gray-500 mt-1">
                Este lead ainda não tem RGM. Informe o número de matrícula para registrar o desfecho.
              </p>
            </div>
          )}

          <div>
            <p className="text-xs font-semibold text-gray-700 mb-2">Desfecho</p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {OUTCOME_BUTTONS.map(({ kind, Icon, tone, toneActive }) => {
                const active = outcome === kind;
                return (
                  <button
                    key={kind}
                    type="button"
                    onClick={() => setOutcome(kind)}
                    className={`px-3 py-3 rounded-xl border text-xs font-medium transition-all flex flex-col items-center gap-1.5 ${active ? toneActive : tone}`}
                  >
                    <Icon className="w-5 h-5" />
                    <span className="text-center leading-tight">{OUTCOME_LABEL[kind]}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <label htmlFor="outcome-motivo" className="text-xs font-semibold text-gray-700 mb-1.5 block">
              Motivo (resumo curto)
            </label>
            <input
              id="outcome-motivo"
              type="text"
              value={motivo}
              onChange={(e) => setMotivo(e.target.value)}
              maxLength={500}
              placeholder="Ex.: cliente quer manter, vai pagar boleto na sexta"
              className="input"
            />
          </div>

          <div>
            <label htmlFor="outcome-notes" className="text-xs font-semibold text-gray-700 mb-1.5 block">
              Observação (detalhes do atendimento)
            </label>
            <textarea
              id="outcome-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              maxLength={2000}
              rows={4}
              placeholder="Contexto da conversa, próximos passos, link de protocolo etc."
              className="input resize-y"
            />
            <p className="text-[11px] text-gray-400 mt-1">{notes.length}/2000</p>
          </div>

          <div className="rounded-lg bg-gray-50 border border-gray-100 px-3 py-2 text-xs text-gray-600">
            <strong className="text-gray-700">Registrando como:</strong> {consultorNome || '—'}
            {item.consultor_responsavel_nome && item.consultor_responsavel_nome !== consultorNome ? (
              <> · lead atribuído originalmente a <em>{item.consultor_responsavel_nome}</em></>
            ) : null}
          </div>

          {error && (
            <div className="rounded-lg bg-rose-50 border border-rose-200 text-sm text-rose-700 px-3 py-2">
              {error}
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-gray-100 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-50"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || !outcome || (canFillRgm && !rgmInput.trim())}
            className="px-4 py-2 text-sm font-semibold text-white bg-whatsapp-600 rounded-lg hover:bg-whatsapp-700 disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-2"
          >
            {saving ? 'Salvando...' : 'Salvar marcação'}
          </button>
        </div>
      </div>
    </div>
  );
}
