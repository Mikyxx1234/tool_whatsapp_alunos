import { RematriculaTrackingPanel } from '../components/RematriculaTrackingPanel';

/** Fila SIAA embedada no dcz — KPIs + histórico diário da campanha. */
export default function RematriculaPage() {
  return (
    <div className="min-h-0 bg-[#0b1623] text-slate-100 p-3 md:p-4 space-y-4">
      <div className="rounded-lg border border-sky-800/40 bg-sky-950/30 px-3 py-2 text-xs text-sky-200/90">
        <strong>Fila de campanha</strong> — alunos EM CURSO ainda pendentes de rematrícula no SIAA.
        Rematrículas <strong>concluídas no novo ciclo</strong> estão no painel principal do CRM (Upload
        Acadêmico → matriculados).
      </div>

      <RematriculaTrackingPanel />
    </div>
  );
}
