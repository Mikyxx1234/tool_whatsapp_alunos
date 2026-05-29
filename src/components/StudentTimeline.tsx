import {
  CheckCircle2,
  AlertTriangle,
  Send,
  Calendar,
  MessageSquare,
  XCircle,
  Activity,
} from 'lucide-react';
import type { TimelineEvent } from '../services/studentApi';

interface StudentTimelineProps {
  events: TimelineEvent[];
}

const ICON_MAP: Record<string, { icon: typeof Send; bg: string; color: string }> = {
  message_sent: { icon: Send, bg: 'bg-emerald-50', color: 'text-emerald-700' },
  message_failed: { icon: XCircle, bg: 'bg-rose-50', color: 'text-rose-700' },
  message_retry: { icon: AlertTriangle, bg: 'bg-amber-50', color: 'text-amber-700' },
  interaction_received: {
    icon: MessageSquare,
    bg: 'bg-blue-50',
    color: 'text-blue-700',
  },
  flow_calculated: { icon: Activity, bg: 'bg-purple-50', color: 'text-purple-700' },
  event_scheduled: { icon: Calendar, bg: 'bg-sky-50', color: 'text-sky-700' },
  event_skipped: { icon: AlertTriangle, bg: 'bg-gray-100', color: 'text-gray-600' },
  future_events_cancelled: { icon: XCircle, bg: 'bg-rose-50', color: 'text-rose-600' },
  access_detected: { icon: CheckCircle2, bg: 'bg-emerald-50', color: 'text-emerald-700' },
  student_imported: { icon: CheckCircle2, bg: 'bg-gray-100', color: 'text-gray-700' },
  student_created: { icon: CheckCircle2, bg: 'bg-gray-100', color: 'text-gray-700' },
  student_updated: { icon: CheckCircle2, bg: 'bg-gray-100', color: 'text-gray-700' },
};

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString('pt-BR');
  } catch {
    return iso;
  }
}

export function StudentTimeline({ events }: StudentTimelineProps) {
  if (events.length === 0) {
    return (
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6 text-center text-gray-500">
        Nenhum evento registrado.
      </div>
    );
  }

  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 sm:p-6">
      <h3 className="text-base font-semibold text-gray-900 mb-4">Timeline</h3>
      <ol className="space-y-3">
        {events.map((ev) => {
          const cfg = ICON_MAP[ev.event_type] || {
            icon: Activity,
            bg: 'bg-gray-100',
            color: 'text-gray-600',
          };
          const Icon = cfg.icon;
          return (
            <li
              key={ev.id}
              className="flex gap-3 p-3 rounded-lg border border-gray-100 hover:bg-gray-50/60"
            >
              <div
                className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${cfg.bg}`}
              >
                <Icon className={`w-4 h-4 ${cfg.color}`} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <p className="text-sm font-medium text-gray-900">
                    {ev.title || ev.event_type}
                  </p>
                  <p className="text-xs text-gray-500">
                    {formatDate(ev.created_at)}
                  </p>
                </div>
                {ev.description && (
                  <p className="text-xs text-gray-600 mt-1 break-words">
                    {ev.description}
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
