import type { ReactElement } from 'react';
import { BrowserRouter, Route, Routes, Navigate, useLocation } from 'react-router-dom';
import DisparadorPage from './pages/DisparadorPage';
import StudentsPage from './pages/StudentsPage';
import StudentDetailPage from './pages/StudentDetailPage';
import AcademicTermsPage from './pages/AcademicTermsPage';
import JourneyRulesPage from './pages/JourneyRulesPage';
import ReportsPage from './pages/ReportsPage';
import BasesPage from './pages/BasesPage';
import ActivationConversionPage from './pages/ActivationConversionPage';
import MeuPainelPage from './pages/MeuPainelPage';
import {
  type AbaSlug,
  ROUTE_TO_ABA,
  firstAllowedRoute,
  getAbasPermitidas,
} from './services/meuPainelApi';

/** Bloqueia a navegacao para rotas que o usuario nao tem permissao de ver.
 *  Quando bloqueia, redireciona pra primeira rota permitida. */
function ProtectedRoute({ slug, children }: { slug: AbaSlug; children: ReactElement }) {
  const allowed = getAbasPermitidas();
  if (allowed === null) return children;
  if (allowed.includes(slug)) return children;
  const fallback = firstAllowedRoute();
  if (fallback === window.location.pathname) {
    // Nada permitido (lista vazia) — mostra mensagem em vez de loop.
    return (
      <div className="min-h-screen flex items-center justify-center p-6 bg-gray-50">
        <div className="max-w-md text-center bg-white rounded-2xl border border-gray-100 p-8 shadow-sm">
          <h1 className="text-lg font-semibold text-gray-900 mb-2">Sem acesso</h1>
          <p className="text-sm text-gray-600">
            Seu usuário não tem permissão para nenhuma aba deste módulo.
            Peça ao administrador do dcz para liberar pelo menos uma aba do
            <strong> Disparador WhatsApp</strong>.
          </p>
        </div>
      </div>
    );
  }
  return <Navigate to={fallback} replace />;
}

function NotFoundRedirect() {
  const { pathname } = useLocation();
  for (const r of ROUTE_TO_ABA) {
    if (r.match(pathname)) {
      return <Navigate to={firstAllowedRoute()} replace />;
    }
  }
  return <Navigate to={firstAllowedRoute()} replace />;
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<ProtectedRoute slug="disparador"><DisparadorPage /></ProtectedRoute>} />
        <Route path="/students" element={<ProtectedRoute slug="alunos"><StudentsPage /></ProtectedRoute>} />
        <Route path="/students/:id" element={<ProtectedRoute slug="alunos"><StudentDetailPage /></ProtectedRoute>} />
        <Route path="/academic-terms" element={<ProtectedRoute slug="calendario"><AcademicTermsPage /></ProtectedRoute>} />
        <Route path="/reports" element={<ProtectedRoute slug="relatorios"><ReportsPage /></ProtectedRoute>} />
        <Route path="/bases" element={<ProtectedRoute slug="bases"><BasesPage /></ProtectedRoute>} />
        <Route path="/journey-rules" element={<ProtectedRoute slug="regras"><JourneyRulesPage /></ProtectedRoute>} />
        <Route path="/conversao" element={<ProtectedRoute slug="conversao"><ActivationConversionPage /></ProtectedRoute>} />
        <Route path="/meu-painel" element={<ProtectedRoute slug="meu_painel"><MeuPainelPage /></ProtectedRoute>} />
        <Route path="*" element={<NotFoundRedirect />} />
      </Routes>
    </BrowserRouter>
  );
}
