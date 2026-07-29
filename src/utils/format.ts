import type { JobStatus } from '../types';

export const statusLabels: Record<JobStatus, string> = {
  running: '运行中',
  queued: '排队中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

export function formatPercent(value: number, total: number) {
  if (total === 0) return 0;
  return Math.round((value / total) * 100);
}
