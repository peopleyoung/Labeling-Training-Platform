import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TrainingJob } from '../types';
import { TrainingPage } from './TrainingPage';

const mocks = vi.hoisted(() => ({ deleteTrainingJob: vi.fn(), notify: vi.fn() }));

const baseJob: TrainingJob = {
  id: 'train-failed',
  name: '失败任务',
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
  config: { type: 'detection', dataFormat: 'YOLO', name: '失败任务', version: 'v2.0.0', datasetId: 'dataset-1', model: 'yolov8m', weightSource: 'pretrained', epochs: 100, batchSize: 8, learningRate: '0.001', imageSize: 640, gpu: 'CPU', mixedPrecision: false, earlyStopping: true },
};

const jobs = [
  baseJob,
  { ...baseJob, id: 'train-running', name: '运行任务', status: 'running' as const },
  ...Array.from({ length: 10 }, (_, index) => ({ ...baseJob, id: `train-page-${index + 1}`, name: `分页任务 ${index + 1}` })),
];

vi.mock('../context/AppContext', () => ({
  useApp: () => ({
    jobs,
    session: { accessToken: 'token', user: { id: 'engineer', workspaceId: 'workspace', username: 'engineer', displayName: 'Engineer', role: 'engineer', mustChangePassword: false } },
    retryTrainingJob: vi.fn(),
    deleteTrainingJob: mocks.deleteTrainingJob,
    notify: mocks.notify,
  }),
}));

describe('TrainingPage delete action', () => {
  beforeEach(() => {
    mocks.deleteTrainingJob.mockReset().mockResolvedValue(undefined);
    mocks.notify.mockReset();
  });

  afterEach(cleanup);

  it('deletes a terminal task after confirmation and hides deletion for running tasks', async () => {
    render(<MemoryRouter><TrainingPage /></MemoryRouter>);

    expect(screen.queryByRole('button', { name: '删除 运行任务' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '删除 失败任务' }));
    expect(screen.getByRole('heading', { name: '删除训练任务及产物' })).toBeInTheDocument();
    expect(screen.getByText(/权重文件/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));

    await waitFor(() => expect(mocks.deleteTrainingJob).toHaveBeenCalledWith('train-failed'));
    expect(screen.queryByRole('heading', { name: '删除训练任务及产物' })).not.toBeInTheDocument();
  });

  it('paginates jobs and exposes the configured model version', () => {
    render(<MemoryRouter><TrainingPage /></MemoryRouter>);

    expect(screen.getAllByText(/v2\.0\.0/).length).toBeGreaterThan(0);
    expect(screen.queryByText('分页任务 9')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    expect(screen.getByText('分页任务 9')).toBeInTheDocument();
  });
});
