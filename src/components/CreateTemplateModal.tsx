import { useEffect, useMemo, useState } from 'react';
import {
  X,
  FilePlus2,
  Loader2,
  AlertCircle,
  CheckCircle2,
  Info,
  Plus,
  Trash2,
  MessageSquareReply,
  Link2,
  Phone,
} from 'lucide-react';
import {
  apiClient,
  type CreateTemplateRequest,
  type TemplateButtonInput,
  type TemplateButtonType,
} from '../services/apiClient';

type Category = 'MARKETING' | 'UTILITY';

const BUTTON_LIMITS: Record<TemplateButtonType, number> = {
  QUICK_REPLY: 3,
  URL: 2,
  PHONE_NUMBER: 1,
};

const BUTTON_LABELS: Record<TemplateButtonType, string> = {
  QUICK_REPLY: 'Resposta rápida',
  URL: 'Abrir URL',
  PHONE_NUMBER: 'Ligar',
};

interface CreateTemplateModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreated: (templateName: string) => void;
}

const NAME_REGEX = /^[a-z0-9_]{1,512}$/;

function countNumericPlaceholders(text: string): number[] {
  if (!text) return [];
  const matches = text.match(/\{\{\s*(\d+)\s*\}\}/g) || [];
  const set = new Set<number>();
  for (const m of matches) {
    const n = parseInt(m.replace(/\D/g, ''), 10);
    if (!Number.isNaN(n)) set.add(n);
  }
  return Array.from(set).sort((a, b) => a - b);
}

export function CreateTemplateModal({ isOpen, onClose, onCreated }: CreateTemplateModalProps) {
  const [name, setName] = useState('');
  const [category, setCategory] = useState<Category>('MARKETING');
  const [language, setLanguage] = useState('pt_BR');
  const [header, setHeader] = useState('');
  const [headerExamples, setHeaderExamples] = useState<string[]>([]);
  const [body, setBody] = useState('');
  const [bodyExamples, setBodyExamples] = useState<string[]>([]);
  const [footer, setFooter] = useState('');
  const [buttons, setButtons] = useState<TemplateButtonInput[]>([]);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitSuccess, setSubmitSuccess] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setSubmitError(null);
      setSubmitSuccess(null);
    }
  }, [isOpen]);

  const headerVarNumbers = useMemo(() => countNumericPlaceholders(header), [header]);
  const bodyVarNumbers = useMemo(() => countNumericPlaceholders(body), [body]);

  // sincroniza tamanho dos arrays de exemplos com o número de placeholders
  useEffect(() => {
    setHeaderExamples((prev) => {
      const next = [...prev];
      while (next.length < headerVarNumbers.length) next.push('');
      return next.slice(0, headerVarNumbers.length);
    });
  }, [headerVarNumbers.length]);

  useEffect(() => {
    setBodyExamples((prev) => {
      const next = [...prev];
      while (next.length < bodyVarNumbers.length) next.push('');
      return next.slice(0, bodyVarNumbers.length);
    });
  }, [bodyVarNumbers.length]);

  const reset = () => {
    setName('');
    setCategory('MARKETING');
    setLanguage('pt_BR');
    setHeader('');
    setHeaderExamples([]);
    setBody('');
    setBodyExamples([]);
    setFooter('');
    setButtons([]);
    setSubmitError(null);
    setSubmitSuccess(null);
  };

  const buttonCounts = useMemo(() => {
    const counts: Record<TemplateButtonType, number> = {
      QUICK_REPLY: 0,
      URL: 0,
      PHONE_NUMBER: 0,
    };
    for (const b of buttons) counts[b.type] += 1;
    return counts;
  }, [buttons]);

  const addButton = (type: TemplateButtonType) => {
    if (buttonCounts[type] >= BUTTON_LIMITS[type]) return;
    const next: TemplateButtonInput = { type, text: '' };
    if (type === 'URL') next.url = 'https://';
    if (type === 'PHONE_NUMBER') next.phoneNumber = '';
    setButtons((prev) => [...prev, next]);
  };

  const updateButton = (index: number, patch: Partial<TemplateButtonInput>) => {
    setButtons((prev) => prev.map((b, i) => (i === index ? { ...b, ...patch } : b)));
  };

  const removeButton = (index: number) => {
    setButtons((prev) => prev.filter((_, i) => i !== index));
  };

  const handleClose = () => {
    if (submitting) return;
    onClose();
  };

  const validation = useMemo(() => {
    if (!name.trim()) return 'Informe o nome do template.';
    if (!NAME_REGEX.test(name)) {
      return 'Nome inválido. Use apenas letras minúsculas, números e _ (ex: "minha_promo").';
    }
    if (!body.trim()) return 'O corpo (body) é obrigatório.';
    if (header.length > 60) return 'Header tem limite de 60 caracteres.';
    if (footer.length > 60) return 'Footer tem limite de 60 caracteres.';
    if (body.length > 1024) return 'Body tem limite de 1024 caracteres.';
    if (headerExamples.some((v) => !v.trim())) {
      return 'Preencha um exemplo para cada variável do header.';
    }
    if (bodyExamples.some((v) => !v.trim())) {
      return 'Preencha um exemplo para cada variável do body.';
    }
    for (let i = 0; i < buttons.length; i++) {
      const b = buttons[i];
      const idx = `Botão #${i + 1}`;
      if (!b.text.trim()) return `${idx}: o texto é obrigatório.`;
      if (b.text.length > 25) return `${idx}: texto excede 25 caracteres.`;
      if (b.type === 'URL') {
        const url = (b.url || '').trim();
        if (!url) return `${idx}: informe a URL.`;
        if (!/^https?:\/\//i.test(url)) {
          return `${idx}: a URL deve começar com http:// ou https://.`;
        }
        const placeholders = (url.match(/\{\{\s*\d+\s*\}\}/g) || []).length;
        if (placeholders > 1) {
          return `${idx}: a URL pode ter no máximo uma variável {{1}}.`;
        }
        if (placeholders === 1 && !(b.urlExample || '').trim()) {
          return `${idx}: forneça um exemplo para a variável da URL.`;
        }
      }
      if (b.type === 'PHONE_NUMBER') {
        const phone = (b.phoneNumber || '').trim();
        if (!phone) return `${idx}: informe o número de telefone.`;
        if (!/^\+?\d{8,15}$/.test(phone)) {
          return `${idx}: telefone deve estar em formato internacional (ex: +5511999999999).`;
        }
      }
    }
    return null;
  }, [name, body, header, footer, headerExamples, bodyExamples, buttons]);

  const handleSubmit = async () => {
    if (validation) {
      setSubmitError(validation);
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    setSubmitSuccess(null);

    const payload: CreateTemplateRequest = {
      name: name.trim().toLowerCase(),
      category,
      language,
      body: body.trim(),
    };
    if (header.trim()) payload.header = header.trim();
    if (headerExamples.length > 0) payload.headerExamples = headerExamples;
    if (bodyExamples.length > 0) payload.bodyExamples = bodyExamples;
    if (footer.trim()) payload.footer = footer.trim();
    if (buttons.length > 0) {
      payload.buttons = buttons.map((b) => ({
        type: b.type,
        text: b.text.trim(),
        url: b.url?.trim(),
        urlExample: b.urlExample?.trim(),
        phoneNumber: b.phoneNumber?.trim(),
      }));
    }

    try {
      const res = await apiClient.createTemplate(payload);
      if (res.success) {
        const status = res.template?.status || 'PENDING';
        setSubmitSuccess(
          `Template "${payload.name}" enviado com sucesso. Status: ${status}. ` +
            (status === 'PENDING'
              ? 'Aguarde a aprovação da Meta (geralmente alguns minutos).'
              : '')
        );
        onCreated(payload.name);
        setTimeout(() => {
          reset();
          onClose();
        }, 2200);
      } else {
        setSubmitError(res.error || 'Falha ao criar template.');
      }
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Falha ao criar template.');
    } finally {
      setSubmitting(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start sm:items-center justify-center p-4 overflow-y-auto">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={handleClose} />
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-2xl my-8 animate-in">
        <div className="flex items-center justify-between p-5 border-b border-gray-100">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-whatsapp-50 rounded-full flex items-center justify-center">
              <FilePlus2 className="w-5 h-5 text-whatsapp-600" />
            </div>
            <div>
              <h3 className="text-lg font-semibold text-gray-900">Cadastrar template</h3>
              <p className="text-xs text-gray-500">
                Crie um novo template MARKETING ou UTILITY na sua conta WhatsApp Business.
              </p>
            </div>
          </div>
          <button
            onClick={handleClose}
            disabled={submitting}
            className="p-1.5 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100 transition-colors disabled:opacity-50"
            aria-label="Fechar"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-5 max-h-[70vh] overflow-y-auto">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Nome (snake_case)" hint="Ex: promo_maio_2026">
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value.toLowerCase())}
                placeholder="minha_promo"
                className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-whatsapp-500/20 focus:border-whatsapp-500"
              />
            </Field>
            <Field label="Idioma" hint="Ex: pt_BR, en, es">
              <input
                type="text"
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
                placeholder="pt_BR"
                className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-whatsapp-500/20 focus:border-whatsapp-500"
              />
            </Field>
          </div>

          <Field label="Categoria">
            <div className="grid grid-cols-2 gap-2">
              {(['MARKETING', 'UTILITY'] as Category[]).map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setCategory(c)}
                  className={`px-3 py-2.5 text-sm font-medium rounded-lg border transition-colors ${
                    category === c
                      ? 'bg-whatsapp-50 border-whatsapp-500 text-whatsapp-700'
                      : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'
                  }`}
                >
                  {c === 'MARKETING' ? 'Marketing' : 'Utility'}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-gray-400 mt-1.5">
              MARKETING = promoções/ofertas. UTILITY = transacional (confirmação, lembrete, status).
            </p>
          </Field>

          <Field
            label="Cabeçalho (opcional)"
            hint={`Texto curto, até 60 caracteres. Use {{1}}, {{2}}... para variáveis.`}
          >
            <input
              type="text"
              value={header}
              onChange={(e) => setHeader(e.target.value)}
              maxLength={60}
              placeholder="Promoção {{1}}"
              className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-whatsapp-500/20 focus:border-whatsapp-500"
            />
            <ExamplesEditor
              prefix="Header"
              numbers={headerVarNumbers}
              values={headerExamples}
              onChange={setHeaderExamples}
            />
          </Field>

          <Field
            label="Corpo (obrigatório)"
            hint="Até 1024 caracteres. Use {{1}}, {{2}}... para variáveis."
          >
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={5}
              maxLength={1024}
              placeholder="Olá {{1}}, sua matrícula no curso {{2}} está confirmada!"
              className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-whatsapp-500/20 focus:border-whatsapp-500 resize-none"
            />
            <div className="flex justify-end text-xs text-gray-400 mt-0.5">{body.length}/1024</div>
            <ExamplesEditor
              prefix="Body"
              numbers={bodyVarNumbers}
              values={bodyExamples}
              onChange={setBodyExamples}
            />
          </Field>

          <Field label="Rodapé (opcional)" hint="Até 60 caracteres. Sem variáveis.">
            <input
              type="text"
              value={footer}
              onChange={(e) => setFooter(e.target.value)}
              maxLength={60}
              placeholder="Cancele a qualquer momento"
              className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-whatsapp-500/20 focus:border-whatsapp-500"
            />
          </Field>

          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-sm font-medium text-gray-700">
                Botões (opcional)
                <span className="ml-1 text-xs font-normal text-gray-400">
                  {buttons.length} adicionado(s)
                </span>
              </label>
              <div className="flex gap-1">
                <AddButtonAction
                  type="QUICK_REPLY"
                  icon={<MessageSquareReply className="w-3.5 h-3.5" />}
                  count={buttonCounts.QUICK_REPLY}
                  onAdd={addButton}
                />
                <AddButtonAction
                  type="URL"
                  icon={<Link2 className="w-3.5 h-3.5" />}
                  count={buttonCounts.URL}
                  onAdd={addButton}
                />
                <AddButtonAction
                  type="PHONE_NUMBER"
                  icon={<Phone className="w-3.5 h-3.5" />}
                  count={buttonCounts.PHONE_NUMBER}
                  onAdd={addButton}
                />
              </div>
            </div>

            {buttons.length === 0 ? (
              <p className="text-xs text-gray-400 px-3 py-2 bg-gray-50 border border-gray-100 rounded-lg">
                Nenhum botão. Limite: 3 respostas rápidas, 2 URLs e 1 telefone.
              </p>
            ) : (
              <div className="space-y-2">
                {buttons.map((b, idx) => (
                  <ButtonRow
                    key={idx}
                    index={idx}
                    button={b}
                    onChange={(patch) => updateButton(idx, patch)}
                    onRemove={() => removeButton(idx)}
                  />
                ))}
              </div>
            )}
          </div>

          <div className="flex items-start gap-2 p-3 bg-blue-50 border border-blue-100 rounded-lg">
            <Info className="w-4 h-4 text-blue-500 flex-shrink-0 mt-0.5" />
            <p className="text-xs text-blue-700">
              Após o envio, a Meta revisa o template (geralmente em minutos). Ele só fica disponível
              para disparo quando o status mudar para <b>APPROVED</b>.
            </p>
          </div>

          {submitError && (
            <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-100 rounded-lg">
              <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
              <p className="text-xs text-red-700">{submitError}</p>
            </div>
          )}

          {submitSuccess && (
            <div className="flex items-start gap-2 p-3 bg-emerald-50 border border-emerald-100 rounded-lg">
              <CheckCircle2 className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5" />
              <p className="text-xs text-emerald-700">{submitSuccess}</p>
            </div>
          )}
        </div>

        <div className="flex gap-3 p-5 border-t border-gray-100">
          <button
            onClick={handleClose}
            disabled={submitting}
            className="flex-1 px-4 py-2.5 text-sm font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50"
          >
            Cancelar
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting || Boolean(validation)}
            className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium text-white bg-whatsapp-500 hover:bg-whatsapp-600 rounded-lg transition-colors disabled:bg-gray-200 disabled:text-gray-400 disabled:cursor-not-allowed"
          >
            {submitting ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Enviando...
              </>
            ) : (
              'Enviar para revisão'
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

interface FieldProps {
  label: string;
  hint?: string;
  children: React.ReactNode;
}

function Field({ label, hint, children }: FieldProps) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1.5">{label}</label>
      {children}
      {hint && <p className="text-[11px] text-gray-400 mt-1">{hint}</p>}
    </div>
  );
}

interface ExamplesEditorProps {
  prefix: string;
  numbers: number[];
  values: string[];
  onChange: (next: string[]) => void;
}

interface AddButtonActionProps {
  type: TemplateButtonType;
  icon: React.ReactNode;
  count: number;
  onAdd: (type: TemplateButtonType) => void;
}

function AddButtonAction({ type, icon, count, onAdd }: AddButtonActionProps) {
  const limit = BUTTON_LIMITS[type];
  const disabled = count >= limit;
  return (
    <button
      type="button"
      onClick={() => onAdd(type)}
      disabled={disabled}
      title={`${BUTTON_LABELS[type]} (${count}/${limit})`}
      className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-gray-600 bg-white border border-gray-200 rounded-md hover:bg-gray-50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
    >
      <Plus className="w-3 h-3" />
      {icon}
      <span className="hidden sm:inline">{BUTTON_LABELS[type]}</span>
    </button>
  );
}

interface ButtonRowProps {
  index: number;
  button: TemplateButtonInput;
  onChange: (patch: Partial<TemplateButtonInput>) => void;
  onRemove: () => void;
}

function ButtonRow({ index, button, onChange, onRemove }: ButtonRowProps) {
  const urlPlaceholders =
    button.type === 'URL'
      ? (button.url || '').match(/\{\{\s*\d+\s*\}\}/g) || []
      : [];

  return (
    <div className="p-3 border border-gray-100 rounded-lg bg-gray-50/40">
      <div className="flex items-center justify-between mb-2">
        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] font-semibold uppercase tracking-wide bg-white border border-gray-200 text-gray-600">
          #{index + 1} · {BUTTON_LABELS[button.type]}
        </span>
        <button
          type="button"
          onClick={onRemove}
          className="p-1 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-md transition-colors"
          aria-label="Remover botão"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="space-y-2">
        <input
          type="text"
          value={button.text}
          onChange={(e) => onChange({ text: e.target.value })}
          maxLength={25}
          placeholder="Texto exibido (até 25 caracteres)"
          className="w-full px-2.5 py-1.5 text-sm border border-gray-200 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-whatsapp-500/20 focus:border-whatsapp-500"
        />

        {button.type === 'URL' && (
          <>
            <input
              type="text"
              value={button.url || ''}
              onChange={(e) => onChange({ url: e.target.value })}
              placeholder="https://exemplo.com/{{1}}"
              className="w-full px-2.5 py-1.5 text-sm font-mono border border-gray-200 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-whatsapp-500/20 focus:border-whatsapp-500"
            />
            {urlPlaceholders.length > 0 && (
              <input
                type="text"
                value={button.urlExample || ''}
                onChange={(e) => onChange({ urlExample: e.target.value })}
                placeholder="Exemplo para a variável da URL"
                className="w-full px-2.5 py-1.5 text-sm border border-gray-200 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-whatsapp-500/20 focus:border-whatsapp-500"
              />
            )}
            <p className="text-[10px] text-gray-400">
              Apenas uma variável <code className="bg-gray-100 px-1 rounded">{'{{1}}'}</code>{' '}
              permitida e ela deve ficar no fim da URL.
            </p>
          </>
        )}

        {button.type === 'PHONE_NUMBER' && (
          <input
            type="text"
            value={button.phoneNumber || ''}
            onChange={(e) => onChange({ phoneNumber: e.target.value })}
            placeholder="+5511999999999"
            className="w-full px-2.5 py-1.5 text-sm font-mono border border-gray-200 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-whatsapp-500/20 focus:border-whatsapp-500"
          />
        )}
      </div>
    </div>
  );
}

function ExamplesEditor({ prefix, numbers, values, onChange }: ExamplesEditorProps) {
  if (numbers.length === 0) return null;
  return (
    <div className="mt-3 p-3 bg-gray-50 border border-gray-100 rounded-lg">
      <p className="text-xs font-medium text-gray-700 mb-2">
        Exemplo de valores ({prefix})
      </p>
      <p className="text-[11px] text-gray-400 mb-2">
        A Meta exige um exemplo plausível para cada variável.
      </p>
      <div className="space-y-2">
        {numbers.map((n, idx) => (
          <div key={n} className="flex items-center gap-2">
            <span className="text-xs font-mono text-gray-500 w-12 flex-shrink-0">
              {`{{${n}}}`}
            </span>
            <input
              type="text"
              value={values[idx] || ''}
              onChange={(e) => {
                const next = [...values];
                next[idx] = e.target.value;
                onChange(next);
              }}
              placeholder={`Exemplo para {{${n}}}`}
              className="flex-1 px-2.5 py-1.5 text-sm border border-gray-200 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-whatsapp-500/20 focus:border-whatsapp-500"
            />
          </div>
        ))}
      </div>
    </div>
  );
}
