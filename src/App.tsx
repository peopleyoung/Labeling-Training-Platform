import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { AppShell } from './components/AppShell';
import { ToastStack } from './components/ui';
import { useApp } from './context/AppContext';
import { effectiveUserRoles, type UserRole } from '../shared/contracts';
import { AnnotationPage } from './pages/AnnotationPage';
import { ConversionsPage } from './pages/ConversionsPage';
import { DashboardPage } from './pages/DashboardPage';
import { DatasetsPage } from './pages/DatasetsPage';
import { ModelsPage } from './pages/ModelsPage';
import { LoginPage } from './pages/LoginPage';
import { TrainingDetailPage } from './pages/TrainingDetailPage';
import { TrainingPage } from './pages/TrainingPage';
import { TrainingWizardPage } from './pages/TrainingWizardPage';
import { AdminPage } from './pages/AdminPage';
import { AnnotationTaskDetailPage, AnnotationTasksPage } from './pages/AnnotationTasksPage';
import { DataCenterPlaceholderPage } from './pages/DataCenterPlaceholderPage';
import { AnnotatorPerformancePage } from './pages/AnnotatorPerformancePage';

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

function RoleRoute({ allowed, children }: { allowed: UserRole[]; children: ReactNode }) {
  const { apiEnabled, session } = useApp();
  if (apiEnabled && session && !effectiveUserRoles(session.user).some((role) => allowed.includes(role))) return <Navigate to="/datasets" replace />;
  return children;
}

function DataCenterRoute() {
  const { session } = useApp();
  const isAdmin = session ? effectiveUserRoles(session.user).includes('admin') : false;
  return isAdmin ? <DataCenterPlaceholderPage /> : <DatasetsPage />;
}

function AnnotationTaskRoute() {
  const { session } = useApp();
  const isAdmin = session ? effectiveUserRoles(session.user).includes('admin') : false;
  return isAdmin ? <DatasetsPage pageTitle="任务中心" /> : <AnnotationTasksPage />;
}

export function App() {
  return (
    <>
      <Routes>
        <Route path="login" element={<LoginPage />} />
        <Route element={<ProtectedShell />}>
          <Route index element={<RoleRoute allowed={['admin', 'reviewer']}><DashboardPage /></RoleRoute>} />
          <Route path="datasets" element={<DataCenterRoute />} />
          <Route path="tasks" element={<RoleRoute allowed={['admin', 'reviewer']}><AnnotationTaskRoute /></RoleRoute>} />
          <Route path="tasks/:datasetId" element={<RoleRoute allowed={['admin', 'reviewer']}><AnnotationTaskDetailPage /></RoleRoute>} />
          <Route path="training" element={<RoleRoute allowed={['admin', 'reviewer']}><TrainingPage /></RoleRoute>} />
          <Route path="training/new" element={<RoleRoute allowed={['admin', 'reviewer']}><TrainingWizardPage /></RoleRoute>} />
          <Route path="training/:jobId" element={<RoleRoute allowed={['admin', 'reviewer']}><TrainingDetailPage /></RoleRoute>} />
          <Route path="models" element={<RoleRoute allowed={['admin', 'reviewer']}><ModelsPage /></RoleRoute>} />
          <Route path="conversions" element={<RoleRoute allowed={['admin', 'reviewer']}><ConversionsPage /></RoleRoute>} />
          <Route path="admin" element={<RoleRoute allowed={['admin']}><AdminPage /></RoleRoute>} />
          <Route path="admin/annotation-statistics" element={<RoleRoute allowed={['admin']}><AnnotatorPerformancePage /></RoleRoute>} />
        </Route>
        <Route path="annotate/:datasetId" element={<ProtectedAnnotation />} />
        <Route path="annotate/:datasetId/job/:jobId" element={<ProtectedAnnotation />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <ToastStack />
    </>
  );
}
