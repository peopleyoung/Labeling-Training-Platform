import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversionTask } from '../types';
import { ConversionsPage } from './ConversionsPage';

const mocks = vi.hoisted(() => ({ deleteConversion: vi.fn(), notify: vi.fn() }));

const baseTask: ConversionTask = {
  id: 'convert-failed',
  modelName: '失败模型',
  modelVersion: 'v1',
  format: 'ONNX',
  precision: 'FP32',
  target: 'Intel CPU',
  status: 'failed',
  progress: 40,
  size: '计算失败',
  createdAt: '2026-08-01T00:00:00.000Z',
};

const conversions: ConversionTask[] = [
  baseTask,
  { ...baseTask, id: 'convert-running', modelName: '运行模型', status: 'running', progress: 50 },
  ...Array.from({ length: 10 }, (_, index) => ({ ...baseTask, id: `convert-page-${index + 1}`, modelName: `分页模型 ${index + 1}`, status: 'completed' as const, progress: 100 })),
];

vi.mock('../context/AppContext', () => ({
  useApp: () => ({
    conversions,
    models: [],
    session: { accessToken: 'token', user: { id: 'reviewer', workspaceId: 'workspace', username: 'reviewer', displayName: 'Reviewer', role: 'reviewer', mustChangePassword: false } },
    gpuEnabled: false,
    cpuConversionFormats: ['ONNX', 'TorchScript', 'OpenVINO'],
    createConversion: vi.fn(),
    cancelConversion: vi.fn(),
    deleteConversion: mocks.deleteConversion,
    downloadArtifact: vi.fn(),
    notify: mocks.notify,
  }),
}));

describe('ConversionsPage task list', () => {
  beforeEach(() => {
    mocks.deleteConversion.mockReset().mockResolvedValue(undefined);
    mocks.notify.mockReset();
  });

  afterEach(cleanup);

  it('paginates conversion tasks with 10, 20, and 50 item options', () => {
    render(<MemoryRouter><ConversionsPage /></MemoryRouter>);

    expect(screen.getByLabelText('每页显示条数')).toHaveValue('10');
    expect(screen.getAllByRole('option').filter((option) => ['10 条', '20 条', '50 条'].includes(option.textContent ?? '')).map((option) => option.textContent)).toEqual(['10 条', '20 条', '50 条']);
    expect(screen.queryByText('分页模型 9')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    expect(screen.getByText('分页模型 9')).toBeInTheDocument();
  });

  it('deletes a terminal conversion after confirmation and hides deletion for running tasks', async () => {
    render(<MemoryRouter><ConversionsPage /></MemoryRouter>);

    expect(screen.queryByRole('button', { name: '删除 运行模型 ONNX 转换' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '删除 失败模型 ONNX 转换' }));
    expect(screen.getByRole('heading', { name: '删除转换任务及产物' })).toBeInTheDocument();
    expect(screen.getByText(/永久删除/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));

    await waitFor(() => expect(mocks.deleteConversion).toHaveBeenCalledWith(baseTask.id));
    await waitFor(() => expect(screen.queryByRole('heading', { name: '删除转换任务及产物' })).not.toBeInTheDocument());
  });
});
