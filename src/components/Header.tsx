import {
  MessageSquare,
  History,
  Users,
  CalendarDays,
  SlidersHorizontal,
  BarChart3,
  Files,
  TrendingUp,
  ClipboardCheck,
} from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';

interface HeaderProps {
  onShowHistory?: () => void;
  showHistoryButton?: boolean;
}

const NAV: Array<{
  to: string;
  label: string;
  icon?: typeof Users;
  match: (path: string) => boolean;
}> = [
  { to: '/', label: 'Disparador', match: (p) => p === '/' },
  { to: '/students', label: 'Alunos', icon: Users, match: (p) => p.startsWith('/students') },
  {
    to: '/academic-terms',
    label: 'Calendário',
    icon: CalendarDays,
    match: (p) => p.startsWith('/academic-terms'),
  },
  {
    to: '/bases',
    label: 'Bases',
    icon: Files,
    match: (p) => p.startsWith('/bases'),
  },
  {
    to: '/reports',
    label: 'Relatórios',
    icon: BarChart3,
    match: (p) => p.startsWith('/reports'),
  },
  {
    to: '/conversao',
    label: 'Conversão',
    icon: TrendingUp,
    match: (p) => p.startsWith('/conversao'),
  },
  {
    to: '/meu-painel',
    label: 'Meu Painel',
    icon: ClipboardCheck,
    match: (p) => p.startsWith('/meu-painel'),
  },
  {
    to: '/journey-rules',
    label: 'Regras',
    icon: SlidersHorizontal,
    match: (p) => p.startsWith('/journey-rules'),
  },
];

export function Header({ onShowHistory, showHistoryButton = true }: HeaderProps) {
  const { pathname } = useLocation();

  return (
    <header className="bg-white border-b border-gray-100 sticky top-0 z-40">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <Link to="/" className="flex items-center gap-3 min-w-0 shrink">
            <div className="w-10 h-10 bg-whatsapp-500 rounded-xl flex items-center justify-center shrink-0">
              <MessageSquare className="w-5 h-5 text-white" />
            </div>
            <div className="min-w-0">
              <h1 className="text-lg sm:text-xl font-semibold text-gray-900 truncate">
                Disparador WhatsApp
              </h1>
              <p className="text-xs sm:text-sm text-gray-500 hidden sm:block">
                Disparos manuais + Régua Inteligente de relacionamento
              </p>
            </div>
          </Link>

          {showHistoryButton && onShowHistory && (
            <button
              type="button"
              onClick={onShowHistory}
              className="inline-flex items-center gap-2 px-3 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors shrink-0"
            >
              <History className="w-4 h-4" />
              <span className="hidden sm:inline">Histórico</span>
            </button>
          )}
        </div>

        <nav
          className="flex items-center gap-1 overflow-x-auto pb-0.5 -mx-1 px-1 scrollbar-thin"
          aria-label="Navegação principal"
        >
          {NAV.map((item) => {
            const active = item.match(pathname);
            const Icon = item.icon;
            return (
              <Link
                key={item.to}
                to={item.to}
                className={`px-3 py-2 text-sm rounded-lg font-medium transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 ${
                  active
                    ? 'bg-whatsapp-50 text-whatsapp-700'
                    : 'text-gray-600 hover:bg-gray-50'
                }`}
              >
                {Icon && <Icon className="w-4 h-4 shrink-0" />}
                {item.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
