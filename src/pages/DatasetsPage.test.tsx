import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthUser, Dataset } from '../types';
import { DatasetsPage } from './DatasetsPage';
import { ApiClient } from '../services/apiClient';

const mocks = vi.hoisted(() => ({
  datasets: [] as Dataset[],
  session: { accessToken: 'token', user: { id: 'admin', workspaceId: 'workspace', username: 'admin', displayName: 'Admin', role: 'admin', mustChangePassword: false } as AuthUser },
  createDataset: vi.fn(),
  notify: vi.fn(),
  refreshAdminData: vi.fn(),
  refreshDatasets: vi.fn(),
  datasetAssets: vi.fn(),
  processingRuns: vi.fn(),
  annotationTask: vi.fn(),
  datasetImages: vi.fn(),
  annotationSegments: vi.fn(),
  annotationJobs: vi.fn(),
  claimNextAnnotationJob: vi.fn(),
  claimNextAnnotationReviewJob: vi.fn(),
  claimAnnotationReviewJob: vi.fn(),
  createDatasetExport: vi.fn(),
  loadDatasetExports: vi.fn(),
}));

vi.mock('../context/AppContext', () => ({
  useApp: () => ({
    datasets: mocks.datasets,
    exports: [],
    users: [],
    session: mocks.session,
    refreshAdminData: mocks.refreshAdminData,
    refreshDatasets: mocks.refreshDatasets,
    createDataset: mocks.createDataset,
    uploadDatasetAssets: vi.fn(),
    datasetAssets: mocks.datasetAssets,
    uploadSessions: vi.fn(),
    processingRuns: mocks.processingRuns,
    startDatasetProcessing: vi.fn(),
    openAnnotationTask: vi.fn(),
    annotationTask: mocks.annotationTask,
    datasetImages: mocks.datasetImages,
    annotationSegments: mocks.annotationSegments,
    annotationJobs: mocks.annotationJobs,
    claimNextAnnotationJob: mocks.claimNextAnnotationJob,
    claimNextAnnotationReviewJob: mocks.claimNextAnnotationReviewJob,
    claimAnnotationReviewJob: mocks.claimAnnotationReviewJob,
    deleteDataset: vi.fn(),
    datasetDeletionPreview: vi.fn(),
    createDatasetExport: mocks.createDatasetExport,
    loadDatasetExports: mocks.loadDatasetExports,
    downloadArtifact: vi.fn(),
    notify: mocks.notify,
  }),
}));

describe('DatasetsPage create-task form', () => {
  beforeEach(() => {
    vi.spyOn(ApiClient.prototype, 'taskCatalog').mockResolvedValue({ categories: [{ id: 'c1', code: 'c1', name: '检测', description: '', enabled: true, sortOrder: 0, createdAt: '' }], taskTypes: [{ id: 't1', code: 't1', name: '缺陷检测', categoryId: 'c1', description: '', enabled: true, sortOrder: 0, createdAt: '', datasetCount: 0 }] });
    mocks.datasets.length = 0;
    mocks.session.user.role = 'admin';
    mocks.createDataset.mockReset();
    mocks.notify.mockReset();
    mocks.refreshAdminData.mockReset().mockResolvedValue(undefined);
    mocks.refreshDatasets.mockReset().mockResolvedValue(undefined);
    mocks.annotationTask.mockReset();
    mocks.datasetImages.mockReset().mockResolvedValue([]);
    mocks.annotationSegments.mockReset().mockResolvedValue([]);
    mocks.annotationJobs.mockReset().mockResolvedValue([]);
    mocks.claimNextAnnotationJob.mockReset();
    mocks.claimNextAnnotationReviewJob.mockReset();
    mocks.claimAnnotationReviewJob.mockReset();
    mocks.createDatasetExport.mockReset().mockResolvedValue('export-1');
    mocks.loadDatasetExports.mockReset().mockResolvedValue(undefined);
    mocks.datasetAssets.mockReset().mockResolvedValue([]);
    mocks.processingRuns.mockReset().mockResolvedValue([]);
  });

  afterEach(cleanup);

  it('uses the task-center title when rendered from the annotation task route', () => {
    render(<MemoryRouter><DatasetsPage pageTitle="任务中心" /></MemoryRouter>);

    expect(screen.getByRole('heading', { name: '任务中心' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '数据中心' })).not.toBeInTheDocument();
  });

  it('rejects an API-invalid dataset name before creating a dataset', async () => {
    render(<MemoryRouter><DatasetsPage /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: '创建任务' }));
    fireEvent.change(screen.getByLabelText('数据集名称'), { target: { value: 'A' } });
    await screen.findByRole('option', { name: '缺陷检测' });
    fireEvent.change(screen.getByLabelText('业务任务'), { target: { value: 't1' } });
    fireEvent.click(screen.getByRole('button', { name: '添加标签' }));
    fireEvent.change(screen.getByLabelText('标签名称 1'), { target: { value: '缺陷' } });
    fireEvent.click(screen.getByRole('button', { name: '创建并上传' }));

    await waitFor(() => expect(mocks.createDataset).not.toHaveBeenCalled());
    expect(mocks.notify).toHaveBeenCalledWith('数据集未创建', expect.stringContaining('name'), 'error');
  });

  it('renders preprocessing booleans as normal single control fields', () => {
    render(<MemoryRouter><DatasetsPage /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: '创建任务' }));

    const zipField = screen.getByText('使用压缩块').closest('label');
    const zOrderField = screen.getByText('启用 Z 顺序').closest('label');
    expect(zipField).not.toBeNull();
    expect(zOrderField).not.toBeNull();
    expect(zipField?.querySelector('.processing-checkbox-control')).not.toBeInTheDocument();
    expect(zOrderField?.querySelector('.processing-checkbox-control')).not.toBeInTheDocument();
  });

  it('claims a job before reading annotator-scoped images', async () => {
    mocks.session.user.role = 'annotator';
    mocks.datasets.push({ id: 'dataset-1', name: '标注数据', description: '', version: 'v1', images: 2, annotated: 0, classes: ['缺陷'], labels: [], updatedAt: '2026-09-02T00:00:00.000Z', size: '20 B', status: '标注中' });
    const job = { id: 'job-1', datasetId: 'dataset-1', annotationTaskId: 'task-1', segmentId: 'segment-1', sequence: 1, status: 'available' as const, createdAt: '2026-09-02T00:00:00.000Z' };
    mocks.annotationJobs.mockResolvedValue([job]);
    mocks.claimNextAnnotationJob.mockResolvedValue({ ...job, status: 'claimed' as const, assigneeId: 'annotator' });
    mocks.annotationSegments.mockResolvedValue([{ id: 'segment-1', datasetId: 'dataset-1', annotationTaskId: 'task-1', sequence: 1, startItemId: 'image-1', endItemId: 'image-2', itemCount: 2 }]);
    mocks.datasetImages.mockImplementation(() => Promise.resolve(mocks.claimNextAnnotationJob.mock.calls.length ? [{ id: 'image-1', datasetId: 'dataset-1', filename: 'image-1.png', mimeType: 'image/png', sizeBytes: 10, split: 'train', createdAt: '2026-09-02T00:00:00.000Z' }] : []));

    render(<MemoryRouter><DatasetsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByRole('button', { name: '继续标注' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '继续标注' }));

    await waitFor(() => expect(mocks.claimNextAnnotationJob).toHaveBeenCalledWith('dataset-1'));
    await waitFor(() => expect(mocks.datasetImages).toHaveBeenCalled());
    expect(mocks.notify).not.toHaveBeenCalledWith('无法打开标注', expect.anything(), expect.anything());
  });

  it('claims a submitted review Job from the data center before opening it', async () => {
    mocks.datasets.push({ id: 'dataset-1', name: '待审核数据', description: '', version: 'v1', images: 1, annotated: 1, classes: ['缺陷'], labels: [], updatedAt: '2026-09-02T00:00:00.000Z', size: '10 B', status: '待审核' });
    const submittedJob = { id: 'review-job-1', datasetId: 'dataset-1', annotationTaskId: 'task-1', segmentId: 'segment-1', sequence: 1, status: 'submitted' as const, assigneeId: 'annotator-1', createdAt: '2026-09-02T00:00:00.000Z' };
    mocks.annotationSegments.mockResolvedValue([{ id: 'segment-1', datasetId: 'dataset-1', annotationTaskId: 'task-1', sequence: 1, startItemId: 'image-1', endItemId: 'image-1', itemCount: 1 }]);
    mocks.annotationJobs.mockResolvedValue([submittedJob]);
    mocks.claimAnnotationReviewJob.mockResolvedValue({ ...submittedJob, status: 'reviewing' as const, reviewerId: 'admin' });
    mocks.datasetImages.mockResolvedValue([{ id: 'image-1', datasetId: 'dataset-1', filename: 'image-1.png', mimeType: 'image/png', sizeBytes: 10, split: 'train', createdAt: '2026-09-02T00:00:00.000Z' }]);

    render(<MemoryRouter><DatasetsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByRole('button', { name: '审核任务段' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '审核任务段' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '审核' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '审核' }));

    await waitFor(() => expect(mocks.claimAnnotationReviewJob).toHaveBeenCalledWith('review-job-1'));
  });

  it('refreshes datasets while polling processing completion', async () => {
    mocks.datasets.push({ id: 'dataset-1', name: '处理中的数据', description: '', version: 'v1', images: 0, annotated: 0, classes: [], labels: [], updatedAt: '2026-09-02T00:00:00.000Z', size: '0 B', status: '标注中' });

    render(<MemoryRouter><DatasetsPage /></MemoryRouter>);

    await waitFor(() => expect(mocks.refreshDatasets).toHaveBeenCalled());
  });

  it('creates a dataset-wide export without a task segment picker', async () => {
    mocks.datasets.push({ id: 'dataset-1', name: '部分审核数据', description: '', version: 'v1', images: 2, annotated: 1, classes: ['缺陷'], labels: [], updatedAt: '2026-09-02T00:00:00.000Z', size: '20 B', status: '待审核' });

    render(<MemoryRouter><DatasetsPage /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: '导出 部分审核数据' }));

    expect(screen.getByRole('dialog', { name: '导出标注数据' })).toBeInTheDocument();
    expect(screen.queryByText(/已审核 Job/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '创建导出任务' }));

    await waitFor(() => expect(mocks.createDatasetExport).toHaveBeenCalledWith('dataset-1', { format: 'COCO', versionName: '部分审核数据_v1', includeImages: true }));
  });
});
