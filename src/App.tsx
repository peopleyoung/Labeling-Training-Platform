import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { ToastStack } from './components/ui';
import { useApp } from './context/AppContext';
import { AnnotationPage } from './pages/AnnotationPage';
import { ConversionsPage } from './pages/ConversionsPage';
import { DashboardPage } from './pages/DashboardPage';
import { DatasetsPage } from './pages/DatasetsPage';
import { ModelsPage } from './pages/ModelsPage';
import { LoginPage } from './pages/LoginPage';
import { TrainingDetailPage } from './pages/TrainingDetailPage';
import { TrainingPage } from './pages/TrainingPage';
import { TrainingWizardPage } from './pages/TrainingWizardPage';

function ProtectedShell() {
  const { apiEnabled, session } = useApp();
  const location = useLocation();
  if (apiEnabled && !session) return <Navigate to="/login" replace state={{ from: location }} />;
  return <AppShell />;
}

function ProtectedAnnotation() {
  const { apiEnabled, session } = useApp();
  const location = useLocation();
  if (apiEnabled && !session) return <Navigate to="/login" replace state={{ from: location }} />;
  return <AnnotationPage />;
}

export function App() {
  return (
    <>
      <Routes>
        <Route path="login" element={<LoginPage />} />
        <Route element={<ProtectedShell />}>
          <Route index element={<DashboardPage />} />
          <Route path="datasets" element={<DatasetsPage />} />
          <Route path="training" element={<TrainingPage />} />
          <Route path="training/new" element={<TrainingWizardPage />} />
          <Route path="training/:jobId" element={<TrainingDetailPage />} />
          <Route path="models" element={<ModelsPage />} />
          <Route path="conversions" element={<ConversionsPage />} />
        </Route>
        <Route path="annotate/:datasetId" element={<ProtectedAnnotation />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <ToastStack />
    </>
  );
}
