import { useEffect, useState } from 'react';
import {
  type AcademicTermDTO,
  type AcademicTermInput,
  type LiberacaoAcesso,
  type TipoInicio,
} from '../services/academicTermApi';

interface AcademicTermFormProps {
  initial?: Partial<AcademicTermDTO>;
  onSubmit: (input: AcademicTermInput) => Promise<void> | void;
  onCancel: () => void;
  submitting?: boolean;
}

function toDateInput(value: string | null | undefined): string {
  if (!value) return '';
  // aceita "2026-01-15", "2026-01-15T00:00:00.000Z" ou Date
  const s = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

const TIPOS_INICIO: Array<{ id: TipoInicio; label: string; description: string }> = [
  { id: 'imediato',     label: 'Imediato',          description: 'Aluno entra logo após matrícula' },
  { id: 'data_fixa',    label: 'Data fixa',         description: 'Inicia exatamente em inicio_conteudo' },
  { id: 'proximo_mes',  label: 'Próximo mês',       description: 'Primeiro dia do mês seguinte à matrícula' },
  { id: 'manual',       label: 'Manual',            description: 'Requer override individual no aluno' },
];

const LIBERACOES: Array<{ id: LiberacaoAcesso; label: string }> = [
  { id: 'imediato', label: 'Imediato' },
  { id: 'D+1',      label: 'D+1' },
  { id: 'D+2',      label: 'D+2' },
  { id: 'custom',   label: 'Custom (dias)' },
];

export function AcademicTermForm({
  initial,
  onSubmit,
  onCancel,
  submitting,
}: AcademicTermFormProps) {
  const [codigo, setCodigo] = useState(initial?.codigo || '');
  const [nome, setNome] = useState(initial?.nome || '');
  const [descricao, setDescricao] = useState(initial?.descricao || '');
  const [nivel, setNivel] = useState<string>(initial?.nivel || '');
  const [ciclo, setCiclo] = useState<string>(initial?.ciclo || '');
  const [inicioMatricula, setInicioMatricula] = useState(toDateInput(initial?.inicio_matricula));
  const [fimMatricula, setFimMatricula] = useState(toDateInput(initial?.fim_matricula));
  const [inicioConteudo, setInicioConteudo] = useState(toDateInput(initial?.inicio_conteudo));
  const [fimConteudo, setFimConteudo] = useState(toDateInput(initial?.fim_conteudo));
  const [temAmbientacao, setTemAmbientacao] = useState(initial?.tem_ambientacao || false);
  const [diasAmbientacao, setDiasAmbientacao] = useState(initial?.dias_ambientacao ?? 0);
  const [conteudoPrevio, setConteudoPrevio] = useState(initial?.conteudo_previo_liberado || false);
  const [permitirAtraso, setPermitirAtraso] = useState(initial?.permitir_atraso || false);
  const [diasAtrasoMax, setDiasAtrasoMax] = useState(initial?.dias_atraso_max ?? 0);
  const [tipoInicio, setTipoInicio] = useState<TipoInicio>(initial?.tipo_inicio || 'data_fixa');
  const [liberacao, setLiberacao] = useState<LiberacaoAcesso>(initial?.liberacao_acesso || 'imediato');
  const [liberacaoDias, setLiberacaoDias] = useState(initial?.liberacao_acesso_dias ?? 0);
  const [ativo, setAtivo] = useState(initial?.ativo ?? true);

  // se initial mudar (ex: clicar em outra turma), atualiza
  useEffect(() => {
    if (!initial) return;
    setCodigo(initial.codigo || '');
    setNome(initial.nome || '');
    setDescricao(initial.descricao || '');
    setNivel(initial.nivel || '');
    setCiclo(initial.ciclo || '');
    setInicioMatricula(toDateInput(initial.inicio_matricula));
    setFimMatricula(toDateInput(initial.fim_matricula));
    setInicioConteudo(toDateInput(initial.inicio_conteudo));
    setFimConteudo(toDateInput(initial.fim_conteudo));
    setTemAmbientacao(initial.tem_ambientacao || false);
    setDiasAmbientacao(initial.dias_ambientacao ?? 0);
    setConteudoPrevio(initial.conteudo_previo_liberado || false);
    setPermitirAtraso(initial.permitir_atraso || false);
    setDiasAtrasoMax(initial.dias_atraso_max ?? 0);
    setTipoInicio(initial.tipo_inicio || 'data_fixa');
    setLiberacao(initial.liberacao_acesso || 'imediato');
    setLiberacaoDias(initial.liberacao_acesso_dias ?? 0);
    setAtivo(initial.ativo ?? true);
  }, [initial]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onSubmit({
      codigo: codigo.trim(),
      nome: nome.trim(),
      descricao: descricao || null,
      nivel: nivel || null,
      ciclo: ciclo || null,
      inicio_matricula: inicioMatricula || null,
      fim_matricula: fimMatricula || null,
      inicio_conteudo: inicioConteudo || null,
      fim_conteudo: fimConteudo || null,
      tem_ambientacao: temAmbientacao,
      dias_ambientacao: Number(diasAmbientacao) || 0,
      conteudo_previo_liberado: conteudoPrevio,
      permitir_atraso: permitirAtraso,
      dias_atraso_max: Number(diasAtrasoMax) || 0,
      tipo_inicio: tipoInicio,
      liberacao_acesso: liberacao,
      liberacao_acesso_dias: Number(liberacaoDias) || 0,
      ativo,
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Field label="Código" required>
          <input
            type="text"
            value={codigo}
            onChange={(e) => setCodigo(e.target.value)}
            placeholder="ex: 2026/1-EAD"
            className="input"
            required
          />
        </Field>
        <Field label="Nome" required>
          <input
            type="text"
            value={nome}
            onChange={(e) => setNome(e.target.value)}
            placeholder="Turma 2026/1 EAD"
            className="input"
            required
          />
        </Field>
      </div>
      <Field label="Descrição">
        <textarea
          rows={2}
          value={descricao || ''}
          onChange={(e) => setDescricao(e.target.value)}
          className="input"
        />
      </Field>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Field label="Nível">
          <select value={nivel} onChange={(e) => setNivel(e.target.value)} className="input">
            <option value="">— selecionar —</option>
            <option value="graduacao">Graduação</option>
            <option value="pos_graduacao">Pós-graduação</option>
            <option value="tecnico">Técnico</option>
            <option value="outro">Outro</option>
          </select>
        </Field>
        <Field label="Ciclo" hint="Formato livre, recomendado YYYY/N (ex.: 2026/1)">
          <input
            type="text"
            value={ciclo}
            onChange={(e) => setCiclo(e.target.value)}
            placeholder="2026/1"
            className="input"
          />
        </Field>
      </div>

      <fieldset className="border border-gray-200 rounded-xl p-4 space-y-4">
        <legend className="text-sm font-semibold px-2">Janelas acadêmicas</legend>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="Início da matrícula">
            <input type="date" value={inicioMatricula || ''} onChange={(e) => setInicioMatricula(e.target.value)} className="input" />
          </Field>
          <Field label="Fim da matrícula">
            <input type="date" value={fimMatricula || ''} onChange={(e) => setFimMatricula(e.target.value)} className="input" />
          </Field>
          <Field label="Início do conteúdo" hint="Usado pelo decisionEngine para o GAP">
            <input type="date" value={inicioConteudo || ''} onChange={(e) => setInicioConteudo(e.target.value)} className="input" />
          </Field>
          <Field label="Fim do conteúdo">
            <input type="date" value={fimConteudo || ''} onChange={(e) => setFimConteudo(e.target.value)} className="input" />
          </Field>
        </div>
      </fieldset>

      <fieldset className="border border-gray-200 rounded-xl p-4 space-y-3">
        <legend className="text-sm font-semibold px-2">Tipo de início</legend>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {TIPOS_INICIO.map((opt) => (
            <label
              key={opt.id}
              className={`flex items-start gap-3 rounded-lg border p-3 cursor-pointer text-sm ${
                tipoInicio === opt.id
                  ? 'border-whatsapp-500 bg-whatsapp-50'
                  : 'border-gray-200 hover:bg-gray-50'
              }`}
            >
              <input
                type="radio"
                name="tipo_inicio"
                checked={tipoInicio === opt.id}
                onChange={() => setTipoInicio(opt.id)}
                className="mt-1"
              />
              <div>
                <p className="font-medium text-gray-900">{opt.label}</p>
                <p className="text-xs text-gray-500">{opt.description}</p>
              </div>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="border border-gray-200 rounded-xl p-4 space-y-4">
        <legend className="text-sm font-semibold px-2">Configurações da jornada</legend>
        <Toggle
          label="Existe ambientação?"
          description="Período de onboarding antes do início do conteúdo."
          checked={temAmbientacao}
          onChange={setTemAmbientacao}
        />
        {temAmbientacao && (
          <Field label="Dias de ambientação" hint="Quantos dias o aluno tem de ambientação">
            <input
              type="number"
              min={0}
              value={diasAmbientacao}
              onChange={(e) => setDiasAmbientacao(Number(e.target.value))}
              className="input w-32"
            />
          </Field>
        )}

        <Toggle
          label="Conteúdo prévio liberado?"
          description="Alunos desta turma entram na aba Conteúdo prévio no Disparador (separada do BB). Configure o template nessa aba."
          checked={conteudoPrevio}
          onChange={setConteudoPrevio}
        />

        <Toggle
          label="Pode haver atraso no início?"
          description="Permite que a data de início real seja postergada sem reclassificar."
          checked={permitirAtraso}
          onChange={setPermitirAtraso}
        />
        {permitirAtraso && (
          <Field label="Atraso máximo (dias)">
            <input
              type="number"
              min={0}
              value={diasAtrasoMax}
              onChange={(e) => setDiasAtrasoMax(Number(e.target.value))}
              className="input w-32"
            />
          </Field>
        )}

        <Field label="Liberação de acesso" hint="Quando o aluno passa a poder acessar a plataforma">
          <select
            value={liberacao}
            onChange={(e) => setLiberacao(e.target.value as LiberacaoAcesso)}
            className="input"
          >
            {LIBERACOES.map((l) => (
              <option key={l.id} value={l.id}>{l.label}</option>
            ))}
          </select>
        </Field>
        {liberacao === 'custom' && (
          <Field label="Dias após matrícula (custom)">
            <input
              type="number"
              min={0}
              value={liberacaoDias}
              onChange={(e) => setLiberacaoDias(Number(e.target.value))}
              className="input w-32"
            />
          </Field>
        )}
      </fieldset>

      <Toggle
        label="Turma ativa"
        description="Turmas inativas são preservadas mas não recebem novos eventos."
        checked={ativo}
        onChange={setAtivo}
      />

      <div className="flex justify-end gap-2 pt-2">
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50"
        >
          Cancelar
        </button>
        <button
          type="submit"
          disabled={submitting}
          className="px-4 py-2 text-sm font-medium text-white bg-whatsapp-500 rounded-lg hover:bg-whatsapp-600 disabled:opacity-50"
        >
          {submitting ? 'Salvando…' : 'Salvar turma'}
        </button>
      </div>
    </form>
  );
}

function Field({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-sm font-medium text-gray-700 mb-1">
        {label} {required && <span className="text-rose-600">*</span>}
      </span>
      {children}
      {hint && <span className="block text-xs text-gray-500 mt-1">{hint}</span>}
    </label>
  );
}

function Toggle({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-3 cursor-pointer">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`mt-0.5 w-10 h-6 rounded-full relative transition-colors ${
          checked ? 'bg-whatsapp-500' : 'bg-gray-300'
        }`}
      >
        <span
          className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${
            checked ? 'translate-x-4' : 'translate-x-0'
          }`}
        />
      </button>
      <div>
        <p className="text-sm font-medium text-gray-900">{label}</p>
        {description && <p className="text-xs text-gray-500">{description}</p>}
      </div>
    </label>
  );
}
