import { BrowserRouter, Route, Routes, Navigate } from 'react-router-dom';
import DisparadorPage from './pages/DisparadorPage';
import StudentsPage from './pages/StudentsPage';
import StudentDetailPage from './pages/StudentDetailPage';
import AcademicTermsPage from './pages/AcademicTermsPage';
import JourneyRulesPage from './pages/JourneyRulesPage';
import ReportsPage from './pages/ReportsPage';
import BasesPage from './pages/BasesPage';
import ActivationConversionPage from './pages/ActivationConversionPage';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<DisparadorPage />} />
        <Route path="/students" element={<StudentsPage />} />
        <Route path="/students/:id" element={<StudentDetailPage />} />
        <Route path="/academic-terms" element={<AcademicTermsPage />} />
        <Route path="/reports" element={<ReportsPage />} />
        <Route path="/bases" element={<BasesPage />} />
        <Route path="/journey-rules" element={<JourneyRulesPage />} />
        <Route path="/conversao" element={<ActivationConversionPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
