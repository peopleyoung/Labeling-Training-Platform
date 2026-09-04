import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversionTask, ModelVersion } from '../types';
import { ModelsPage } from './ModelsPage';

const mocks = vi.hoisted(() => ({ deleteModel: vi.fn(), notify: vi.fn() }));
const model: ModelVersion = { id: 'model-1', name: '缺陷检测', version: 'train-1', task: 'detection', sourceJob: 'train-1', metricName: 'mAP@50', metricValue: '0.91', framework: 'PyTorch', size: '10 MB', createdAt: '2026-08-01T00:00:00.000Z', formats: ['ONNX'], stage: '评估中', artifactId: 'artifact-1' };
const conversion: ConversionTask = { id: 'convert-1', modelName: model.name, modelVersion: model.version, format: 'ONNX', precision: 'FP32', target: 'Intel CPU', status: 'completed', progress: 100, size: '9 MB', createdAt: '2026-08-01T00:00:00.000Z' };

vi.mock('../context/AppContext', () => ({
  useApp: () => ({
    models: [model],
    jobs: [{ id: 'train-1', name: '缺陷检测训练' }],
    conversions: [conversion],
    session: { accessToken: 'token', user: { id: 'reviewer', workspaceId: 'workspace', username: 'reviewer', displayName: 'Reviewer', role: 'reviewer', mustChangePassword: false } },
    uploadModel: vi.fn(),
    updateModelStage: vi.fn(),
    deleteModel: mocks.deleteModel,
    downloadArtifact: vi.fn(),
    notify: mocks.notify,
  }),
}));

describe('ModelsPage delete action', () => {
  beforeEach(() => {
    mocks.deleteModel.mockReset().mockResolvedValue(undefined);
    mocks.notify.mockReset();
  });

  afterEach(cleanup);

  it('confirms that the model and dependent conversion artifacts are permanently deleted', async () => {
    render(<MemoryRouter><ModelsPage /></MemoryRouter>);
    expect(screen.getByText('训练任务：缺陷检测训练')).toBeInTheDocument();
    expect(screen.getByText('历史版本')).toBeInTheDocument();
    expect(screen.queryByText(/train-1/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '删除 缺陷检测' }));
    expect(screen.getByRole('heading', { name: '删除模型及产物' })).toBeInTheDocument();
    expect(screen.getByText(/1 个转换任务及其产物/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
    await waitFor(() => expect(mocks.deleteModel).toHaveBeenCalledWith(model.id));
  });
});
