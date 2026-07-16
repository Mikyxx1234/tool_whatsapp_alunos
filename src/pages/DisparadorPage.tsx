import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { Header } from '../components/Header';
import { ActivationPanel } from '../components/ActivationPanel';
import { UploadCard } from '../components/UploadCard';
import { ValidationSummary } from '../components/ValidationSummary';
import { ContactsPreviewTable } from '../components/ContactsPreviewTable';
import { MessageEditor } from '../components/MessageEditor';
import { TemplateSelector } from '../components/TemplateSelector';
import { CreateTemplateModal } from '../components/CreateTemplateModal';
import { CampaignTypeSelector } from '../components/CampaignTypeSelector';
import { WhatsAppPreview } from '../components/WhatsAppPreview';
import { CampaignSummary } from '../components/CampaignSummary';
import { CampaignProgress } from '../components/CampaignProgress';
import { CampaignExports } from '../components/CampaignExports';
import { ConfirmModal } from '../components/ConfirmModal';
import { CampaignHistory } from '../components/CampaignHistory';
import { Toast, type ToastVariant } from '../components/Toast';
import { OperationModeSelector, type OperationMode } from '../components/OperationModeSelector';
import { NovoCrmSyncPanel } from '../components/NovoCrmSyncPanel';
import { StudentImportPreviewTable } from '../components/StudentImportPreviewTable';
import { JourneySummary, type JourneySummaryData } from '../components/JourneySummary';

import type {
  CampaignProgress as Progress,
  CampaignStatusType,
  CampaignType,
  Contact,
  ContactStatus,
  UploadedFileMeta,
  WhatsAppTemplate,
} from '../types';
import { parseContactsCsv } from '../services/csvParser';
import { parseStudentsCsv, type StudentImportRow } from '../services/studentCsvParser';
import { apiClient } from '../services/apiClient';
import { campaignApi, toApiContact } from '../services/campaignApi';
import { studentApi } from '../services/studentApi';

interface ToastState {
  message: string;
  variant: ToastVariant;
  visible: boolean;
}

const INITIAL_PROGRESS: Progress = {
  total: 0,
  sent: 0,
  failed: 0,
  pending: 0,
  status: 'idle',
};

const TERMINAL_STATUSES = new Set([
  'completed',
  'completed_with_errors',
  'failed',
  'cancelled',
]);

function dbStatusToCampaignStatus(s: string): CampaignStatusType {
  if (s === 'sending' || s === 'paused' || s === 'validating') return 'running';
  if (s === 'completed') return 'completed';
  if (s === 'cancelled') return 'cancelled';
  if (s === 'failed' || s === 'completed_with_errors') return 'failed';
  return 'idle';
}

function dbContactToLocal(remote: {
  id: string;
  phone: string;
  normalized_phone: string;
  name: string | null;
  email: string | null;
  course: string | null;
  origem: string | null;
  validation_status: string;
  send_status: string;
  interaction_status: string;
  error_message: string | null;
}): Contact {
  let status: ContactStatus = 'pending';
  if (remote.validation_status === 'invalid') status = 'invalid';
  else if (remote.validation_status === 'duplicate') status = 'duplicate';
  else if (remote.send_status === 'sent') status = 'sent';
  else if (remote.send_status === 'failed') status = 'error';
  else if (remote.send_status === 'sending' || remote.send_status === 'queued') status = 'sending';
  else if (remote.send_status === 'pending' && remote.validation_status === 'valid') status = 'pending';
  else if (remote.validation_status === 'valid') status = 'valid';
  return {
    id: remote.id,
    rawPhone: remote.phone,
    phone: remote.normalized_phone,
    name: remote.name || undefined,
    email: remote.email || undefined,
    curso: remote.course || undefined,
    origem: remote.origem || undefined,
    extras: {},
    status,
    errorMessage: remote.error_message || undefined,
  };
}

export default function DisparadorPage() {
  const [, setSearchParams] = useSearchParams();

  /* ----------------------------------------------------------------- */
  /* Estado global                                                     */
  /* ----------------------------------------------------------------- */
  const [mode, setMode] = useState<OperationMode>(() => {
    const q = new URLSearchParams(window.location.search).get('mode');
    if (q === 'activation') return 'activation';
    if (q === 'sync_crm') return 'sync_crm';
    if (q === 'journey') return 'journey';
    return 'manual';
  });

  // Modo manual
  const [file, setFile] = useState<UploadedFileMeta | null>(null);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [isParsing, setIsParsing] = useState(false);

  // Modo régua
  const [studentRows, setStudentRows] = useState<StudentImportRow[]>([]);
  const [studentFileMeta, setStudentFileMeta] = useState<UploadedFileMeta | null>(null);
  const [journeySummary, setJourneySummary] = useState<JourneySummaryData | null>(null);
  const [isImportingStudents, setIsImportingStudents] = useState(false);

  const [campaignName, setCampaignName] = useState('');
  const [intervalSeconds, setIntervalSeconds] = useState('5');
  const [dailyLimit, setDailyLimit] = useState('500');

  const [campaignTypes, setCampaignTypes] = useState<CampaignType[]>([]);
  const [campaignTypeCode, setCampaignTypeCode] = useState<string | null>(null);
  const [typesLoading, setTypesLoading] = useState(false);
  const [typesError, setTypesError] = useState<string | null>(null);

  const [templates, setTemplates] = useState<WhatsAppTemplate[]>([]);
  const [templateName, setTemplateName] = useState<string | null>(null);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [templatesError, setTemplatesError] = useState<string | null>(null);

  const [modalOpen, setModalOpen] = useState(false);
  const [createTemplateOpen, setCreateTemplateOpen] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [historyVersion, setHistoryVersion] = useState(0);

  const [activeCampaignId, setActiveCampaignId] = useState<string | null>(null);
  const [currentCampaignId, setCurrentCampaignId] = useState<string | null>(null);
  const [progress, setProgress] = useState<Progress>(INITIAL_PROGRESS);
  const [campaignStatus, setCampaignStatus] = useState<CampaignStatusType>('idle');
  const pollRef = useRef<number | null>(null);

  const [toast, setToast] = useState<ToastState>({
    message: '',
    variant: 'success',
    visible: false,
  });

  const showToast = useCallback((message: string, variant: ToastVariant = 'success') => {
    setToast({ message, variant, visible: true });
  }, []);
  const hideToast = useCallback(() => {
    setToast((t) => ({ ...t, visible: false }));
  }, []);

  /* ----------------------------------------------------------------- */
  /* Bootstrap                                                         */
  /* ----------------------------------------------------------------- */
  const fetchTypes = useCallback(async () => {
    setTypesLoading(true);
    setTypesError(null);
    try {
      const list = await campaignApi.listTypes();
      setCampaignTypes(list);
    } catch (err) {
      setTypesError(err instanceof Error ? err.message : 'Erro desconhecido');
    } finally {
      setTypesLoading(false);
    }
  }, []);

  const fetchTemplates = useCallback(async () => {
    setTemplatesLoading(true);
    setTemplatesError(null);
    try {
      const { templates: list } = await apiClient.listTemplates();
      setTemplates(list);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Erro ao carregar templates';
      setTemplatesError(msg);
      showToast(`Falha ao buscar templates: ${msg}`, 'error');
    } finally {
      setTemplatesLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    fetchTypes();
    fetchTemplates();
  }, [fetchTypes, fetchTemplates]);

  /* ----------------------------------------------------------------- */
  /* Polling                                                           */
  /* ----------------------------------------------------------------- */
  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const refreshActiveCampaign = useCallback(async (id: string) => {
    try {
      const [campaign, remoteContacts] = await Promise.all([
        campaignApi.get(id),
        campaignApi.listContacts(id, { limit: 2000 }),
      ]);

      setProgress({
        total: campaign.total_valid,
        sent: campaign.total_sent,
        failed: campaign.total_failed,
        pending:
          Math.max(0, campaign.total_valid - campaign.total_sent - campaign.total_failed),
        status: dbStatusToCampaignStatus(campaign.status),
      });

      const localized = remoteContacts.map(dbContactToLocal);
      setContacts(localized);

      const status = dbStatusToCampaignStatus(campaign.status);
      setCampaignStatus(status);

      if (TERMINAL_STATUSES.has(campaign.status)) {
        return { done: true, dbStatus: campaign.status };
      }
      return { done: false, dbStatus: campaign.status };
    } catch (err) {
      console.warn('[poll] falha:', err);
      return { done: false, dbStatus: null };
    }
  }, []);

  useEffect(() => {
    if (!activeCampaignId) {
      stopPolling();
      return;
    }
    refreshActiveCampaign(activeCampaignId).then((r) => {
      if (r.done) {
        showFinishToast(r.dbStatus);
        setHistoryVersion((v) => v + 1);
        setActiveCampaignId(null);
      }
    });
    pollRef.current = window.setInterval(async () => {
      if (!activeCampaignId) return;
      const r = await refreshActiveCampaign(activeCampaignId);
      if (r.done) {
        showFinishToast(r.dbStatus);
        setHistoryVersion((v) => v + 1);
        setActiveCampaignId(null);
      }
    }, 2000);
    return stopPolling;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCampaignId]);

  function showFinishToast(dbStatus: string | null) {
    if (!dbStatus) return;
    if (dbStatus === 'completed') showToast('Disparo concluído com sucesso.', 'success');
    else if (dbStatus === 'cancelled') showToast('Disparo cancelado.', 'info');
    else if (dbStatus === 'completed_with_errors')
      showToast('Concluído com algumas falhas.', 'error');
    else if (dbStatus === 'failed') showToast('Disparo falhou.', 'error');
  }

  /* ----------------------------------------------------------------- */
  /* CSV manual                                                        */
  /* ----------------------------------------------------------------- */
  const validationData = useMemo(() => {
    const valid = contacts.filter((c) =>
      ['valid', 'pending', 'sending', 'sent', 'error'].includes(c.status)
    ).length;
    return {
      total: contacts.length,
      valid,
      invalid: contacts.filter((c) => c.status === 'invalid').length,
      duplicates: contacts.filter((c) => c.status === 'duplicate').length,
    };
  }, [contacts]);

  const sendableCount = useMemo(
    () => contacts.filter((c) => c.status === 'valid').length,
    [contacts]
  );

  const selectedTemplate = useMemo(
    () => templates.find((t) => t.name === templateName) || null,
    [templates, templateName]
  );

  const sampleVariables = useMemo(() => {
    const firstValid = contacts.find((c) => c.status === 'valid');
    if (!firstValid) return undefined;
    return {
      nome: firstValid.name || '',
      curso: firstValid.curso || '',
      email: firstValid.email || '',
      origem: firstValid.origem || '',
      ...firstValid.extras,
    };
  }, [contacts]);

  const handleManualUpload = useCallback(
    async (selectedFile: File) => {
      if (campaignStatus === 'running') {
        showToast('Há uma campanha em andamento.', 'error');
        return;
      }
      setIsParsing(true);
      try {
        const { contacts: parsed, totalRows } = await parseContactsCsv(selectedFile);
        setContacts(parsed);
        setFile({ name: selectedFile.name, size: selectedFile.size, lines: totalRows });
        setProgress(INITIAL_PROGRESS);
        setCampaignStatus('idle');
        setActiveCampaignId(null);
        setCurrentCampaignId(null);
        showToast(`CSV carregado: ${parsed.length} contatos lidos.`, 'success');
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Erro ao ler CSV';
        showToast(`Falha ao ler CSV: ${msg}`, 'error');
      } finally {
        setIsParsing(false);
      }
    },
    [campaignStatus, showToast]
  );

  const handleStudentsUpload = useCallback(
    async (selectedFile: File) => {
      setIsParsing(true);
      try {
        const { rows, totalRows } = await parseStudentsCsv(selectedFile);
        setStudentRows(rows);
        setStudentFileMeta({
          name: selectedFile.name,
          size: selectedFile.size,
          lines: totalRows,
        });
        setJourneySummary(null);
        showToast(`CSV de alunos carregado: ${rows.length} linha(s).`, 'success');
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Erro ao ler CSV';
        showToast(`Falha ao ler CSV: ${msg}`, 'error');
      } finally {
        setIsParsing(false);
      }
    },
    [showToast]
  );

  const handleFileUpload = useCallback(
    async (selectedFile: File) => {
      if (mode === 'activation') return;
      if (mode === 'journey') return handleStudentsUpload(selectedFile);
      return handleManualUpload(selectedFile);
    },
    [mode, handleManualUpload, handleStudentsUpload]
  );

  const handleRemoveFile = useCallback(() => {
    if (campaignStatus === 'running') {
      showToast('Cancele o disparo antes de remover o arquivo.', 'error');
      return;
    }
    setFile(null);
    setContacts([]);
    setProgress(INITIAL_PROGRESS);
    setCampaignStatus('idle');
    setActiveCampaignId(null);
    setCurrentCampaignId(null);
    setStudentRows([]);
    setStudentFileMeta(null);
    setJourneySummary(null);
  }, [campaignStatus, showToast]);

  const handleModeChange = useCallback(
    (next: OperationMode) => {
      if (next !== 'activation' && next !== 'sync_crm' && campaignStatus === 'running') {
        showToast('Aguarde o término do disparo atual antes de trocar de modo.', 'error');
        return;
      }
      setMode(next);
      if (next === 'activation' || next === 'sync_crm' || next === 'journey') {
        setSearchParams({ mode: next }, { replace: true });
      } else {
        setSearchParams({}, { replace: true });
      }
      if (next !== 'activation' && next !== 'sync_crm') {
        handleRemoveFile();
      }
    },
    [campaignStatus, showToast, handleRemoveFile, setSearchParams]
  );

  /* ----------------------------------------------------------------- */
  /* Campanha manual                                                   */
  /* ----------------------------------------------------------------- */
  const blockReason = useMemo(() => {
    if (mode === 'journey') return null;
    if (!campaignTypeCode) return 'Selecione o tipo de campanha';
    if (!file) return 'Faça upload de um CSV';
    if (sendableCount === 0) return 'Nenhum contato válido para envio';
    if (!templateName) return 'Selecione um template aprovado';
    if (!campaignName.trim()) return 'Defina um nome para a campanha';
    return null;
  }, [mode, campaignTypeCode, file, sendableCount, templateName, campaignName]);

  const canStart = blockReason === null && campaignStatus !== 'running';

  const handleStartCampaign = useCallback(() => {
    if (!canStart) {
      if (blockReason) showToast(blockReason, 'error');
      return;
    }
    setModalOpen(true);
  }, [canStart, blockReason, showToast]);

  const handleConfirmCampaign = useCallback(async () => {
    setModalOpen(false);
    if (!selectedTemplate || !campaignTypeCode) return;
    const safeInterval = Math.max(1, parseInt(intervalSeconds, 10) || 2);

    showToast('Criando campanha...', 'info');
    try {
      const created = await campaignApi.create({
        name: campaignName.trim(),
        campaignTypeCode,
        templateName: selectedTemplate.name,
        templateLanguage: selectedTemplate.language,
        templateCategory: selectedTemplate.category,
        sourceFileName: file?.name,
        intervalSeconds: safeInterval,
        dailyLimit: parseInt(dailyLimit, 10) || undefined,
      });

      const apiContacts = contacts.map(toApiContact);
      await campaignApi.addContacts(created.id, apiContacts, file?.name);

      await campaignApi.start(created.id, {
        intervalSeconds: safeInterval,
        dailyLimit: parseInt(dailyLimit, 10) || undefined,
      });

      setActiveCampaignId(created.id);
      setCurrentCampaignId(created.id);
      setCampaignStatus('running');
      showToast('Disparo iniciado.', 'info');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Erro ao iniciar campanha';
      showToast(`Falha: ${msg}`, 'error');
    }
  }, [
    selectedTemplate,
    campaignTypeCode,
    campaignName,
    file,
    intervalSeconds,
    dailyLimit,
    contacts,
    showToast,
  ]);

  const handleCancelCampaign = useCallback(async () => {
    if (!activeCampaignId) return;
    try {
      await campaignApi.cancel(activeCampaignId);
      showToast('Cancelando disparo...', 'info');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Erro';
      showToast(`Falha ao cancelar: ${msg}`, 'error');
    }
  }, [activeCampaignId, showToast]);

  /* ----------------------------------------------------------------- */
  /* Importar alunos                                                   */
  /* ----------------------------------------------------------------- */
  const handleImportStudents = useCallback(async () => {
    if (studentRows.length === 0) {
      showToast('Carregue um CSV de alunos.', 'error');
      return;
    }
    setIsImportingStudents(true);
    try {
      const payload = studentRows
        .filter((r) => !r.errors.length)
        .map((r) => ({
          nome: r.nome,
          telefone: r.telefone,
          email: r.email,
          cpf: r.cpf,
          curso: r.curso,
          polo: r.polo,
          data_matricula: r.dataMatricula,
          data_inicio_conteudo: r.dataInicio,
          data_acesso_liberado: r.dataAcessoLiberado,
          ultimo_acesso: r.ultimoAcesso,
          raw_data: r.raw,
        }));

      const response = await studentApi.importBulk({
        students: payload,
        generateJourney: true,
      });

      setJourneySummary({
        imported: response.imported,
        updated: response.updated,
        total: response.total,
        fluxoCounts: response.fluxoCounts,
        totalEventsGenerated: response.totalEventsGenerated,
        errors: response.errors,
      });
      showToast(
        `Importação concluída: ${response.total} aluno(s), ${response.totalEventsGenerated} evento(s) agendado(s).`,
        'success'
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Erro ao importar';
      showToast(`Falha: ${msg}`, 'error');
    } finally {
      setIsImportingStudents(false);
    }
  }, [studentRows, showToast]);

  const studentValidCount = useMemo(
    () => studentRows.filter((r) => r.errors.length === 0).length,
    [studentRows]
  );

  /* ----------------------------------------------------------------- */
  /* Render                                                            */
  /* ----------------------------------------------------------------- */
  const isJourneyMode = mode === 'journey';
  const isActivationMode = mode === 'activation';
  const isSyncCrmMode = mode === 'sync_crm';

  return (
    <div className="min-h-screen bg-gray-50">
      <Header onShowHistory={() => setShowHistory((v) => !v)} />

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <OperationModeSelector mode={mode} onChange={handleModeChange} />

        {isActivationMode ? (
          <div className="mt-6">
            <ActivationPanel />
          </div>
        ) : isSyncCrmMode ? (
          <div className="mt-6">
            <NovoCrmSyncPanel />
          </div>
        ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 mt-6">
          {/* Left column */}
          <div className="lg:col-span-7 space-y-6">
            {!isJourneyMode && (
              <CampaignTypeSelector
                types={campaignTypes}
                selectedCode={campaignTypeCode}
                onSelect={setCampaignTypeCode}
                loading={typesLoading}
                error={typesError}
              />
            )}
            <UploadCard
              file={isJourneyMode ? studentFileMeta : file}
              onFileSelect={handleFileUpload}
              onRemoveFile={handleRemoveFile}
            />

            {!isJourneyMode && file && (
              <>
                <ValidationSummary data={validationData} isValidating={isParsing} />
                {campaignStatus !== 'idle' && (
                  <CampaignProgress
                    progress={progress}
                    status={campaignStatus}
                    onCancel={handleCancelCampaign}
                  />
                )}
                {currentCampaignId && (
                  <CampaignExports
                    campaignId={currentCampaignId}
                    campaignName={campaignName}
                    refreshKey={progress.sent + progress.failed}
                    onError={(msg) => showToast(`Export: ${msg}`, 'error')}
                  />
                )}
                <ContactsPreviewTable contacts={contacts} />
              </>
            )}

            {isJourneyMode && studentFileMeta && (
              <>
                <StudentImportPreviewTable rows={studentRows} />
                {journeySummary && <JourneySummary data={journeySummary} />}
              </>
            )}
          </div>

          {/* Right column */}
          <div className="lg:col-span-5 space-y-6">
            {!isJourneyMode && (
              <>
                <TemplateSelector
                  templates={templates}
                  selectedTemplateName={templateName}
                  onSelectTemplate={setTemplateName}
                  loading={templatesLoading}
                  error={templatesError}
                  onReload={fetchTemplates}
                  onCreateClick={() => setCreateTemplateOpen(true)}
                />
                <MessageEditor
                  campaignName={campaignName}
                  onCampaignNameChange={setCampaignName}
                  interval={intervalSeconds}
                  onIntervalChange={setIntervalSeconds}
                  dailyLimit={dailyLimit}
                  onDailyLimitChange={setDailyLimit}
                  templateSelected={Boolean(templateName)}
                />
                <WhatsAppPreview
                  template={selectedTemplate}
                  sampleVariables={sampleVariables}
                />
                <CampaignSummary
                  campaignName={campaignName}
                  fileName={file?.name || null}
                  validContacts={sendableCount}
                  interval={intervalSeconds}
                  templateName={templateName}
                  isRunning={campaignStatus === 'running'}
                  canStart={canStart}
                  blockReason={blockReason}
                  onStartCampaign={handleStartCampaign}
                />
              </>
            )}

            {isJourneyMode && (
              <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6 space-y-4">
                <div>
                  <h3 className="text-base font-semibold text-gray-900">
                    Importar e gerar régua
                  </h3>
                  <p className="text-sm text-gray-500 mt-1">
                    Os alunos serão importados, classificados (Fluxo A/B/C) e os
                    eventos da régua serão agendados automaticamente.
                  </p>
                </div>
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-gray-500">Linhas no arquivo</span>
                    <span className="font-medium">{studentRows.length}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">Válidas para importar</span>
                    <span className="font-medium text-emerald-600">
                      {studentValidCount}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">Com erros</span>
                    <span className="font-medium text-rose-600">
                      {studentRows.length - studentValidCount}
                    </span>
                  </div>
                </div>
                <button
                  onClick={handleImportStudents}
                  disabled={isImportingStudents || studentValidCount === 0}
                  className="w-full px-4 py-3 rounded-lg bg-whatsapp-500 text-white font-medium hover:bg-whatsapp-600 transition-colors disabled:bg-gray-200 disabled:text-gray-500 disabled:cursor-not-allowed"
                >
                  {isImportingStudents ? 'Importando...' : 'Importar e gerar régua'}
                </button>
                <p className="text-xs text-gray-500">
                  As mensagens serão enviadas automaticamente nas datas agendadas
                  pelo scheduler do servidor.
                </p>
              </div>
            )}
          </div>
        </div>
        )}

        {!isActivationMode && (
          <div className="mt-8">
            <CampaignHistory visible={showHistory} refreshKey={historyVersion} />
          </div>
        )}
      </main>

      <CreateTemplateModal
        isOpen={createTemplateOpen}
        onClose={() => setCreateTemplateOpen(false)}
        onCreated={(createdName) => {
          showToast(
            `Template "${createdName}" enviado para revisão da Meta.`,
            'success'
          );
          fetchTemplates();
        }}
      />

      <ConfirmModal
        isOpen={modalOpen}
        campaignName={campaignName}
        templateName={templateName}
        validContacts={sendableCount}
        intervalSeconds={parseInt(intervalSeconds, 10) || 0}
        onCancel={() => setModalOpen(false)}
        onConfirm={handleConfirmCampaign}
      />

      <Toast
        message={toast.message}
        variant={toast.variant}
        isVisible={toast.visible}
        onClose={hideToast}
      />
    </div>
  );
}
