import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceActivity } from '../types';
import { DashboardPage, describeActivity } from './DashboardPage';

const activity: WorkspaceActivity = {
  id: 'audit-1',
  action: 'training.create',
  entityType: 'training_job',
  entityId: 'train-1',
  metadata: { model: 'yolov8m', version: 'v2.1.0' },
  actor: { id: 'engineer-1', displayName: '算法工程师' },
  createdAt: new Date().toISOString(),
};

vi.mock('../context/AppContext', () => ({
  useApp: () => ({
    datasets: [],
    jobs: [],
    models: [],
    activities: [activity],
    gpuEnabled: false,
    cpuTrainingEnabled: true,
    cpuOnnxEnabled: true,
  }),
}));

describe('DashboardPage recent activity', () => {
  afterEach(cleanup);

  it('renders audited workspace activity instead of the empty state', () => {
    render(<MemoryRouter><DashboardPage /></MemoryRouter>);

    expect(screen.getByText('创建训练任务')).toBeInTheDocument();
    expect(screen.getByText('算法工程师 · yolov8m · v2.1.0')).toBeInTheDocument();
    expect(screen.queryByText('暂无活动记录')).not.toBeInTheDocument();
  });

  it('uses a safe fallback for an unknown audit action', () => {
    expect(describeActivity({ ...activity, action: 'future.action', actor: null })).toEqual({ title: '更新工作空间资源', detail: '系统', tone: 'blue' });
  });
});
