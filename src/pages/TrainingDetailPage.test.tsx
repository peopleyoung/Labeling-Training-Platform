import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TrainingJob } from '../types';
import { buildTrainingMetricSeries, TrainingDetailPage } from './TrainingDetailPage';

const mocks = vi.hoisted(() => ({ retryTrainingJob: vi.fn(), deleteTrainingJob: vi.fn(), notify: vi.fn() }));

const failedJob: TrainingJob = {
  id: 'train-failed',
  name: '表面缺陷检测',
  type: 'detection',
  model: 'yolov8m',
  dataset: '钢板数据 v1',
  status: 'failed',
  progress: 20,
  epoch: '20 / 100',
  metricName: 'mAP@50',
  metricValue: '--',
  gpu: 'CPU',
  createdAt: '2026-07-28T00:00:00.000Z',
  eta: '训练失败',
  errorMessage: 'Worker exited unexpectedly',
  config: { type: 'detection', dataFormat: 'YOLO', name: '表面缺陷检测', version: 'v2.1.0', datasetId: 'dataset-1', model: 'yolov8m', weightSource: 'pretrained', epochs: 100, batchSize: 8, learningRate: '0.001', imageSize: 640, gpu: 'CPU', mixedPrecision: false, earlyStopping: true },
};

vi.mock('../context/AppContext', () => ({
  useApp: () => ({
    jobs: [failedJob],
    session: { accessToken: 'token', user: { id: 'reviewer', workspaceId: 'workspace', username: 'reviewer', displayName: 'Reviewer', role: 'reviewer', mustChangePassword: false } },
    retryTrainingJob: mocks.retryTrainingJob,
    cancelTrainingJob: vi.fn(),
    deleteTrainingJob: mocks.deleteTrainingJob,
    trainingEvents: vi.fn().mockResolvedValue([]),
    trainingObservability: vi.fn().mockResolvedValue({ metrics: [], resources: [] }),
    downloadArtifact: vi.fn(),
    notify: mocks.notify,
  }),
}));

describe('TrainingDetailPage retry action', () => {
  beforeEach(() => {
    mocks.retryTrainingJob.mockReset().mockResolvedValue('train-retried');
    mocks.deleteTrainingJob.mockReset().mockResolvedValue(undefined);
    mocks.notify.mockReset();
  });

  afterEach(cleanup);

  it('submits a failed task again and opens the new training job', async () => {
    render(
      <MemoryRouter initialEntries={['/training/train-failed']}>
        <Routes>
          <Route path="/training/:jobId" element={<TrainingDetailPage />} />
          <Route path="/training/train-retried" element={<div>新训练任务</div>} />
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: '重新训练' }));

    await waitFor(() => expect(mocks.retryTrainingJob).toHaveBeenCalledWith('train-failed'));
    expect(await screen.findByText('新训练任务')).toBeInTheDocument();
  });

  it('confirms deletion and returns to the training list', async () => {
    render(
      <MemoryRouter initialEntries={['/training/train-failed']}>
        <Routes>
          <Route path="/training/:jobId" element={<TrainingDetailPage />} />
          <Route path="/training" element={<div>训练任务列表</div>} />
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: '删除任务' }));
    expect(screen.getByRole('heading', { name: '删除训练任务' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));

    await waitFor(() => expect(mocks.deleteTrainingJob).toHaveBeenCalledWith('train-failed'));
    expect(await screen.findByText('训练任务列表')).toBeInTheDocument();
  });

  it('keeps quality scores on the left axis and loss on the right axis', () => {
    const point = { id: 'metric-1', jobId: 'train-1', epoch: 1, progress: 10, metrics: { mIoU: 0.75, loss: 0.12 }, createdAt: '2026-07-28T00:00:00.000Z' };
    expect(buildTrainingMetricSeries('segmentation', [point])).toMatchObject([
      { name: 'mIoU', values: [0.75], axis: 'left', format: 'score' },
      { name: 'Loss', values: [0.12], axis: 'right', format: 'number' },
    ]);
  });
});
