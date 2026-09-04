import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnnotationTaskDetailPage, AnnotationTasksPage } from './AnnotationTasksPage';

const mocks = vi.hoisted(() => ({
  annotationSegments: vi.fn(),
  annotationJobs: vi.fn(),
  claimNextAnnotationJob: vi.fn(),
  claimNextAnnotationReviewJob: vi.fn(),
  claimAnnotationReviewJob: vi.fn(),
  datasetImages: vi.fn(),
  notify: vi.fn(),
}));

vi.mock('../context/AppContext', () => ({
  useApp: () => ({
    datasets: [{ id: 'dataset-1', name: '小河边安全帽', description: '矿井图片标注', version: 'v1', images: 100, annotated: 40, classes: ['未戴安全帽', '戴安全帽'], updatedAt: '2026-09-02T00:00:00.000Z', size: '10 MB', status: '标注中' }],
    session: { accessToken: 'test-token', user: { id: 'admin', workspaceId: 'workspace-1', username: 'admin', displayName: '管理员', role: 'admin', roles: ['admin'], mustChangePassword: false } },
    annotationSegments: mocks.annotationSegments,
    annotationJobs: mocks.annotationJobs,
    claimNextAnnotationJob: mocks.claimNextAnnotationJob,
    claimNextAnnotationReviewJob: mocks.claimNextAnnotationReviewJob,
    claimAnnotationReviewJob: mocks.claimAnnotationReviewJob,
    datasetImages: mocks.datasetImages,
    notify: mocks.notify,
  }),
}));

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}{location.search}</output>;
}

describe('AnnotationTasksPage', () => {
  afterEach(() => cleanup());

  it('renders reference-style task cards and filters them by search', () => {
    render(<MemoryRouter><AnnotationTasksPage /></MemoryRouter>);
    expect(screen.getByRole('heading', { name: '任务' })).toBeInTheDocument();
    expect(screen.getByText('小河边安全帽')).toBeInTheDocument();
    expect(screen.getByText('标注进度')).toBeInTheDocument();
  });

  it('loads task segments and exposes a Job-scoped workbench link', async () => {
    mocks.annotationSegments.mockResolvedValue([{ id: 'segment-1', datasetId: 'dataset-1', annotationTaskId: 'task-1', sequence: 1, startItemId: 'image-1', endItemId: 'image-2', itemCount: 2, createdAt: '2026-09-02T00:00:00.000Z' }]);
    mocks.annotationJobs.mockResolvedValue([{ id: 'job-1', datasetId: 'dataset-1', annotationTaskId: 'task-1', segmentId: 'segment-1', sequence: 1, status: 'available', createdAt: '2026-09-02T00:00:00.000Z' }]);
    render(<MemoryRouter initialEntries={['/tasks/dataset-1']}><Routes><Route path="/tasks/:datasetId" element={<AnnotationTaskDetailPage />} /></Routes></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('待领取')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: '查看' })).toBeInTheDocument();
  });

  it('claims a submitted Job before opening the reviewer workbench', async () => {
    const submittedJob = { id: 'job-1', datasetId: 'dataset-1', annotationTaskId: 'task-1', segmentId: 'segment-1', sequence: 1, status: 'submitted' as const, assigneeId: 'annotator-1', createdAt: '2026-09-02T00:00:00.000Z' };
    const claimedJob = { ...submittedJob, status: 'reviewing' as const, reviewerId: 'admin' };
    mocks.annotationSegments.mockResolvedValue([{ id: 'segment-1', datasetId: 'dataset-1', annotationTaskId: 'task-1', sequence: 1, startItemId: 'image-1', endItemId: 'image-2', itemCount: 2, createdAt: '2026-09-02T00:00:00.000Z' }]);
    mocks.annotationJobs.mockResolvedValue([submittedJob]);
    mocks.claimAnnotationReviewJob.mockResolvedValue(claimedJob);
    mocks.datasetImages.mockResolvedValue([{ id: 'image-1', datasetId: 'dataset-1', filename: 'image-1.png', mimeType: 'image/png', sizeBytes: 10, split: 'train', createdAt: '2026-09-02T00:00:00.000Z' }]);

    render(<MemoryRouter initialEntries={['/tasks/dataset-1']}><Routes><Route path="/tasks/:datasetId" element={<AnnotationTaskDetailPage />} /><Route path="/annotate/:datasetId/job/:jobId" element={<LocationProbe />} /></Routes></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('待审核')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '查看' }));

    await waitFor(() => expect(mocks.claimAnnotationReviewJob).toHaveBeenCalledWith('job-1'));
    expect(screen.getByTestId('location')).toHaveTextContent('/annotate/dataset-1/job/job-1?image=image-1&mode=review');
  });
});
