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
  LayoutDashboard,
  Target,
} from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';
import {
  type AbaSlug,
  defaultHomePath,
  getAbasPermitidas,
  hasFullAccess,
  readConsultorIdentity,
} from '../services/meuPainelApi';

interface HeaderProps {
  onShowHistory?: () => void;
  showHistoryButton?: boolean;
}

const NAV: Array<{
  to: string;
  label: string;
  icon?: typeof Users;
  match: (path: string) => boolean;
  slug: AbaSlug;
  fullAccessOnly?: boolean;
}> = [
  {
    to: '/painel',
    label: 'Painel',
    icon: LayoutDashboard,
    slug: 'painel',
    match: (p) => p === '/painel',
    fullAccessOnly: true,
  },
  {
    to: '/metas',
    label: 'Metas',
    icon: Target,
    slug: 'metas',
    match: (p) => p.startsWith('/metas'),
    fullAccessOnly: true,
  },
  { to: '/disparador', label: 'Disparador', slug: 'disparador', match: (p) => p === '/disparador' },
  { to: '/students', label: 'Alunos', icon: Users, slug: 'alunos', match: (p) => p.startsWith('/students') },
  {
    to: '/academic-terms',
    label: 'Calendário',
    icon: CalendarDays,
    slug: 'calendario',
    match: (p) => p.startsWith('/academic-terms'),
  },
  {
    to: '/bases',
    label: 'Bases',
    icon: Files,
    slug: 'bases',
    match: (p) => p.startsWith('/bases'),
  },
  {
    to: '/reports',
    label: 'Relatórios',
    icon: BarChart3,
    slug: 'relatorios',
    match: (p) => p.startsWith('/reports'),
  },
  {
    to: '/conversao',
    label: 'Conversão',
    icon: TrendingUp,
    slug: 'conversao',
    match: (p) => p.startsWith('/conversao'),
  },
  {
    to: '/meu-painel',
    label: 'Meu Painel',
    icon: ClipboardCheck,
    slug: 'meu_painel',
    match: (p) => p.startsWith('/meu-painel'),
  },
  {
    to: '/journey-rules',
    label: 'Regras',
    icon: SlidersHorizontal,
    slug: 'regras',
    match: (p) => p.startsWith('/journey-rules'),
  },
];

export function Header({ onShowHistory, showHistoryButton = true }: HeaderProps) {
  const { pathname } = useLocation();
  const abasPermitidas = getAbasPermitidas();
  const showMgmt = hasFullAccess(readConsultorIdentity());
  const home = defaultHomePath();

  let navVisible = NAV.filter((item) => !item.fullAccessOnly || showMgmt);
  if (abasPermitidas !== null) {
    navVisible = navVisible.filter((item) => abasPermitidas.includes(item.slug));
  }

  return (
    <header className="bg-white border-b border-gray-100 sticky top-0 z-40">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <Link to={home} className="flex items-center gap-3 min-w-0 shrink">
            <div className="w-11 h-11 rounded-2xl bg-gradient-to-br from-sky-500 to-indigo-600 flex items-center justify-center shrink-0 shadow-sm ring-1 ring-white/10">
              <MessageSquare className="w-5 h-5 text-white" />
            </div>
            <div className="min-w-0">
              <h1 className="font-display text-xl sm:text-2xl font-extrabold tracking-[-0.03em] leading-none text-gray-900 truncate">
                Disparador WhatsApp
              </h1>
              <p className="mt-1 text-xs sm:text-sm font-medium text-gray-500 hidden sm:block">
                Disparos manuais + Régua Inteligente de relacionamento
              </p>
            </div>
          </Link>

          {showHistoryButton && onShowHistory && (
            <button
              type="button"
              onClick={onShowHistory}
              className="inline-flex items-center gap-2 px-3 py-2 text-xs font-bold uppercase tracking-[0.12em] text-gray-600 bg-white border border-gray-200 rounded-xl hover:bg-gray-50 transition-colors shrink-0"
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
          {navVisible.map((item) => {
            const active = item.match(pathname);
            const Icon = item.icon;
            return (
              <Link
                key={item.to}
                to={item.to}
                className={`font-display px-3 py-2 text-[0.72rem] rounded-xl font-extrabold uppercase tracking-[0.12em] transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 ${
                  active
                    ? 'bg-primary/10 text-primary border border-primary/20'
                    : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900 border border-transparent'
                }`}
              >
                {Icon && <Icon className="w-3.5 h-3.5 shrink-0" />}
                {item.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
