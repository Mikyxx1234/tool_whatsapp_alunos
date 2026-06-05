import { useEffect, useMemo, useState } from 'react';
import { X, UserPlus, Trash2 } from 'lucide-react';
import {
  type MeuPainelItem,
  type ConsultorAcademico,
  CATEGORY_LABEL,
  assignConsultorToResponse,
  fetchConsultoresDistintos,
  readConsultoresAcademico,
  subscribeConsultoresAcademico,
} from '../services/meuPainelApi';

interface Props {
  open: boolean;
  item: MeuPainelItem | null;
  role: string;
  onClose: () => void;
  onSaved: () => void;
}

export function AssignConsultorModal({ open, item, role, onClose, onSaved }: Props) {
  const [nome, setNome] = useState('');
  const [jaGravados, setJaGravados] = useState<string[]>([]);
  const [academicos, setAcademicos] = useState<ConsultorAcademico[]>(() => readConsultoresAcademico());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open && item) {
      setNome(item.consultor_responsavel_nome ?? '');
      setError(null);
    }
  }, [open, item]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetchConsultoresDistintos()
      .then((r) => {
        if (!cancelled) setJaGravados(r.consultores || []);
      })
      .catch(() => {
        if (!cancelled) setJaGravados([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    setAcademicos(readConsultoresAcademico());
    const unsub = subscribeConsultoresAcademico(() => {
      setAcademicos(readConsultoresAcademico());
    });
    return unsub;
  }, []);

  /** Lista final: acadêmicos do dcz + nomes já gravados que não estão na primeira. */
  const sugestoesFinal = useMemo(() => {
    const fromAcad = academicos.map((c) => c.nome);
    const set = new Set<string>(fromAcad);
    const extras: string[] = [];
    for (const n of jaGravados) {
      if (n && !set.has(n)) {
        extras.push(n);
        set.add(n);
      }
    }
    return [
      ...fromAcad.map((nome) => ({ nome, fonte: 'academico' as const })),
      ...extras.map((nome) => ({ nome, fonte: 'historico' as const })),
    ];
  }, [academicos, jaGravados]);

  if (!open || !item) return null;

  async function handleSave(novoNome: string | null) {
    if (!item) return;
    setSaving(true);
    setError(null);
    try {
      await assignConsultorToResponse(item.response_id, novoNome, role);
      onSaved();
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Erro ao atribuir';
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
        className="bg-white rounded-2xl border border-gray-100 shadow-xl w-full max-w-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-gray-100 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-gray-500">
              Atribuir consultor · {CATEGORY_LABEL[item.category] || item.category}
            </p>
            <h2 className="text-lg font-semibold text-gray-900 truncate" title={item.nome || ''}>
              {item.nome || '(sem nome)'}
            </h2>
            <p className="text-xs text-gray-500 mt-0.5">
              RGM {item.rgm || '—'}
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

        <div className="px-5 py-4 space-y-4">
          {item.consultor_responsavel_nome && (
            <div className="rounded-lg bg-blue-50 border border-blue-200 text-xs text-blue-900 px-3 py-2">
              Atualmente atribuído a <strong>{item.consultor_responsavel_nome}</strong>.
              Você pode reatribuir ou desatribuir.
            </div>
          )}

          <div>
            <label htmlFor="assign-consultor-input" className="text-xs font-semibold text-gray-700 mb-1.5 block">
              Nome do consultor
            </label>
            <input
              id="assign-consultor-input"
              type="text"
              value={nome}
              onChange={(e) => setNome(e.target.value)}
              maxLength={200}
              list="consultores-sugestoes"
              placeholder="Comece a digitar ou selecione abaixo"
              autoFocus
              className="input"
            />
            <datalist id="consultores-sugestoes">
              {sugestoesFinal.map((s) => (
                <option key={s.nome} value={s.nome}>
                  {s.fonte === 'academico' ? 'Acadêmico' : 'Já gravado'}
                </option>
              ))}
            </datalist>
            <p className="text-[11px] text-gray-400 mt-1">
              {academicos.length} acadêmicos · {sugestoesFinal.length - academicos.length} históricos
            </p>

            {/* Lista clicável quando há acadêmicos. Mais rápido que digitar. */}
            {academicos.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5 max-h-32 overflow-y-auto">
                {academicos.map((c) => {
                  const active = nome.trim() === c.nome;
                  return (
                    <button
                      key={c.username}
                      type="button"
                      onClick={() => setNome(c.nome)}
                      title={c.username}
                      className={`px-2 py-1 text-[11px] rounded-md border transition-colors ${
                        active
                          ? 'bg-whatsapp-50 border-whatsapp-300 text-whatsapp-800 font-semibold'
                          : 'bg-white border-gray-200 text-gray-700 hover:bg-gray-50'
                      }`}
                    >
                      {c.nome}
                    </button>
                  );
                })}
              </div>
            )}

            {academicos.length === 0 && (
              <div className="mt-2 rounded-lg bg-amber-50 border border-amber-200 text-[11px] text-amber-800 px-2.5 py-1.5">
                Lista de acadêmicos ainda não chegou do dcz. Aguarde 1-2 segundos ou recarregue.
              </div>
            )}
          </div>

          {error && (
            <div className="rounded-lg bg-rose-50 border border-rose-200 text-sm text-rose-700 px-3 py-2">
              {error}
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-gray-100 flex items-center justify-between gap-2">
          <div>
            {item.consultor_responsavel_nome && (
              <button
                type="button"
                onClick={() => handleSave(null)}
                disabled={saving}
                className="px-3 py-2 text-xs font-semibold text-rose-700 bg-white border border-rose-200 rounded-lg hover:bg-rose-50 disabled:opacity-50 inline-flex items-center gap-1.5"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Desatribuir
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
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
              onClick={() => handleSave(nome.trim() || null)}
              disabled={saving || !nome.trim()}
              className="px-4 py-2 text-sm font-semibold text-white bg-whatsapp-600 rounded-lg hover:bg-whatsapp-700 disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-2"
            >
              <UserPlus className="w-4 h-4" />
              {saving ? 'Salvando...' : 'Atribuir'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
