import { RematriculaReportPanel } from '../components/RematriculaReportPanel';
import { RematriculaTrackingPanel } from '../components/RematriculaTrackingPanel';

/** Painel Rematrícula — embedado no dcz-crm-sync via iframe (/rematricula). */
export default function RematriculaPage() {
  return (
    <div className="min-h-screen bg-[#0b1623] text-slate-100 p-4 md:p-6 space-y-8">
      <RematriculaTrackingPanel />
      <div>
        <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider mb-3">
          Detalhamento por aluno
        </h2>
        <RematriculaReportPanel />
      </div>
    </div>
  );
}
