import { useEffect, useState, type ReactNode } from 'react';
import { X, UserPlus } from 'lucide-react';
import {
  createManualLead,
  fetchConsultoresDistintos,
  getConsultoresAcademicos,
  getMeuPainelBaseLabel,
} from '../services/meuPainelApi';

type ManualCaaTipo = 'caa' | 'caa_atm' | 'caa_ia';

const TIPO_OPTIONS: Array<{ value: ManualCaaTipo; label: string }> = [
  { value: 'caa', label: 'Processos CAA' },
  { value: 'caa_atm', label: 'CAA_ATM' },
  { value: 'caa_ia', label: 'CAA_IA' },
];

interface Props {
  open: boolean;
  defaultConsultorNome: string;
  isAdmin: boolean;
  onClose: () => void;
  onSaved: () => void;
}

export function CreateManualLeadModal({
  open,
  defaultConsultorNome,
  isAdmin,
  onClose,
  onSaved,
}: Props) {
  const [tipo, setTipo] = useState<ManualCaaTipo>('caa_atm');
  const [protocolo, setProtocolo] = useState('');
  const [rgm, setRgm] = useState('');
  const [nome, setNome] = useState('');
  const [cpf, setCpf] = useState('');
  const [telefone, setTelefone] = useState('');
  const [curso, setCurso] = useState('');
  const [polo, setPolo] = useState('');
  const [consultorNome, setConsultorNome] = useState(defaultConsultorNome);
  const [sugestoes, setSugestoes] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setTipo('caa_atm');
      setProtocolo('');
      setRgm('');
      setNome('');
      setCpf('');
      setTelefone('');
      setCurso('');
      setPolo('');
      setConsultorNome(defaultConsultorNome);
      setError(null);
    }
  }, [open, defaultConsultorNome]);

  useEffect(() => {
    if (!open || !isAdmin) return;
    let cancelled = false;
    const fromDcz = getConsultoresAcademicos();
    fetchConsultoresDistintos()
      .then((r) => {
        if (cancelled) return;
        const merged = Array.from(new Set([...(r.consultores || []), ...fromDcz, defaultConsultorNome]))
          .filter(Boolean)
          .sort((a, b) => a.localeCompare(b, 'pt-BR', { sensitivity: 'base' }));
        setSugestoes(merged);
      })
      .catch(() => {
        if (!cancelled) setSugestoes(fromDcz.filter(Boolean));
      });
    return () => {
      cancelled = true;
    };
  }, [open, isAdmin, defaultConsultorNome]);

  if (!open) return null;

  const isRelatorio = tipo === 'caa';

  function selectTipo(next: ManualCaaTipo) {
    setTipo(next);
    if (next !== 'caa') setProtocolo('');
    setError(null);
  }

  async function handleSave() {
    const protoDigits = protocolo.replace(/\D/g, '');
    if (isRelatorio && (!protoDigits || protoDigits.length < 9 || protoDigits.length > 12)) {
      setError('Informe o protocolo CAA (9 a 12 dígitos).');
      return;
    }
    if (!rgm.trim()) {
      setError('RGM é obrigatório.');
      return;
    }
    if (!consultorNome.trim()) {
      setError('Consultor responsável é obrigatório.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await createManualLead({
        category: 'processos-caa',
        origem_ativacao: tipo,
        protocolo: isRelatorio ? protoDigits : null,
        rgm: rgm.trim(),
        nome: nome.trim() || null,
        cpf: cpf.trim() || null,
        telefone: telefone.trim() || null,
        curso: curso.trim() || null,
        polo: polo.trim() || null,
        consultor_nome: consultorNome.trim(),
      });
      onSaved();
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Erro ao criar';
      setError(msg);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
      <div
        role="dialog"
        aria-modal="true"
        className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto"
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
          <div>
            <h2 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
              <UserPlus className="w-4 h-4 text-whatsapp-600" />
              Criar pessoa · Processos CAA
            </h2>
            <p className="text-[11px] text-gray-500 mt-0.5">
              Para leads que não entraram automaticamente no painel
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-4 py-4 space-y-3">
          <div>
            <span className="text-[11px] font-semibold text-gray-600 uppercase tracking-wide">
              Tipo
            </span>
            <div className="mt-1.5 inline-flex w-full rounded-lg border border-gray-200 bg-gray-50 p-0.5">
              {TIPO_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => selectTipo(opt.value)}
                  className={`flex-1 px-2 py-2 text-[11px] sm:text-xs font-semibold rounded-md transition-colors ${
                    tipo === opt.value
                      ? 'bg-white text-gray-900 shadow-sm'
                      : 'text-gray-600 hover:bg-white/60'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <p className="text-[10px] text-gray-500 mt-1.5">
              {isRelatorio
                ? 'Lead do relatório/export CAA — protocolo obrigatório.'
                : 'Conversa com atendente — sem protocolo no CAA.'}
              {' '}
              <span className="text-gray-400">
                ({getMeuPainelBaseLabel('processos-caa', tipo)})
              </span>
            </p>
          </div>

          {isRelatorio && (
            <Field label="Protocolo CAA *" hint="9–12 dígitos">
              <input
                type="text"
                inputMode="numeric"
                value={protocolo}
                onChange={(e) => setProtocolo(e.target.value)}
                placeholder="Ex.: 202401234"
                className={inputCls}
              />
            </Field>
          )}

          <Field label="RGM *">
            <input
              type="text"
              inputMode="numeric"
              value={rgm}
              onChange={(e) => setRgm(e.target.value)}
              placeholder="Matrícula"
              className={inputCls}
            />
          </Field>

          <Field label="Nome">
            <input
              type="text"
              value={nome}
              onChange={(e) => setNome(e.target.value)}
              placeholder="Nome completo do aluno"
              className={inputCls}
            />
          </Field>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="CPF">
              <input
                type="text"
                inputMode="numeric"
                value={cpf}
                onChange={(e) => setCpf(e.target.value)}
                placeholder="Somente números"
                className={inputCls}
              />
            </Field>
            <Field label="Telefone">
              <input
                type="text"
                inputMode="tel"
                value={telefone}
                onChange={(e) => setTelefone(e.target.value)}
                placeholder="DDD + número"
                className={inputCls}
              />
            </Field>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Curso">
              <input
                type="text"
                value={curso}
                onChange={(e) => setCurso(e.target.value)}
                placeholder="Ex.: Administração"
                className={inputCls}
              />
            </Field>
            <Field label="Polo">
              <input
                type="text"
                value={polo}
                onChange={(e) => setPolo(e.target.value)}
                placeholder="Ex.: Barra Funda"
                className={inputCls}
              />
            </Field>
          </div>

          <Field label="Consultor responsável *">
            {isAdmin ? (
              <>
                <input
                  type="text"
                  list="mp-create-consultores"
                  value={consultorNome}
                  onChange={(e) => setConsultorNome(e.target.value)}
                  placeholder="Nome do consultor"
                  className={inputCls}
                />
                <datalist id="mp-create-consultores">
                  {sugestoes.map((s) => (
                    <option key={s} value={s} />
                  ))}
                </datalist>
              </>
            ) : (
              <input
                type="text"
                value={consultorNome}
                readOnly
                className={`${inputCls} bg-gray-50 text-gray-600`}
              />
            )}
          </Field>

          {error && (
            <div className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">
              {error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-gray-100 bg-gray-50 rounded-b-xl">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="px-3 py-2 text-xs font-semibold text-gray-600 hover:bg-gray-100 rounded-lg"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-2 text-xs font-semibold text-white bg-whatsapp-600 hover:bg-whatsapp-700 rounded-lg disabled:opacity-50"
          >
            {saving ? 'Salvando…' : 'Criar pessoa'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-[11px] font-semibold text-gray-600 uppercase tracking-wide">
        {label}
      </span>
      {hint && <span className="ml-1 text-[10px] font-normal text-gray-400 normal-case">{hint}</span>}
      <div className="mt-1">{children}</div>
    </label>
  );
}

const inputCls =
  'w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-whatsapp-500';
