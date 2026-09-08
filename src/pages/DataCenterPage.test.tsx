import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { ApiClient } from '../services/apiClient';
import { DataCenterPage } from './DataCenterPage';
import { TaskCatalogPage } from './TaskCatalogPage';
import type { Dataset } from '../../shared/contracts';
import type { TaskCatalog } from '../../shared/taskCatalog';

const context = vi.hoisted(() => ({ session: { accessToken: 'token' }, exports: [], loadDatasetExports: vi.fn().mockResolvedValue(undefined), createDatasetExport: vi.fn().mockResolvedValue('e1'), downloadArtifact: vi.fn(), refreshDatasets: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../context/AppContext', () => ({ useApp: () => context }));
const catalog: TaskCatalog = {
  categories: [{ id: 'c1', code: 'detection', name: '目标检测', description: '', sortOrder: 0, enabled: true, createdAt: '' }, { id: 'c2', code: 'lane', name: '车道线检测', description: '', sortOrder: 1, enabled: true, createdAt: '' }],
  taskTypes: [{ id: 't1', code: 'vehicle', categoryId: 'c1', name: '车辆检测', description: '', sortOrder: 0, enabled: true, createdAt: '', datasetCount: 1 }, { id: 't2', code: 'lane-task', categoryId: 'c2', name: '道路车道', description: '', sortOrder: 0, enabled: true, createdAt: '', datasetCount: 0 }],
};
const dataset: Dataset = { id: 'd1', taskTypeId: 't1', name: '路口车辆', version: 'v1', description: '白天', createdAt: '2026-09-08T10:00:00Z', approvedAt: '2026-09-08T12:00:00Z', updatedAt: '', images: 10, annotated: 10, classes: ['汽车'], status: '可训练', size: '1 MB' };

describe('administrator data center', () => {
  beforeEach(() => {
    context.loadDatasetExports.mockResolvedValue(undefined);
    context.refreshDatasets.mockResolvedValue(undefined);
    context.createDatasetExport.mockResolvedValue('e1');
    vi.spyOn(ApiClient.prototype, 'taskCatalog').mockResolvedValue(catalog);
    vi.spyOn(ApiClient.prototype, 'dataCenter').mockResolvedValue({ categories: [{ ...catalog.categories[0], datasetCount: 1 }], taskTypes: [catalog.taskTypes[0]], items: [dataset], total: 1, page: 1, pageSize: 20 });
    vi.spyOn(ApiClient.prototype, 'bindDataset').mockResolvedValue({ ...dataset, taskTypeId: 't2' });
    vi.spyOn(ApiClient.prototype, 'saveCatalog').mockResolvedValue(catalog.categories[0]);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });
  it('combines creation dates with linked type filters', async () => {
    render(<MemoryRouter><DataCenterPage /></MemoryRouter>);
    await screen.findByRole('option', { name: '目标检测' });
    fireEvent.change(screen.getByLabelText('创建开始日期'), { target: { value: '2026-09-01' } });
    fireEvent.change(screen.getByLabelText('创建结束日期'), { target: { value: '2026-09-08' } });
    fireEvent.change(screen.getByLabelText('任务大类'), { target: { value: 'detection' } });
    expect(screen.queryByRole('option', { name: '道路车道' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('业务任务'), { target: { value: 'vehicle' } });
    fireEvent.change(screen.getByLabelText('搜索数据集'), { target: { value: '路口' } });
    fireEvent.click(screen.getByRole('button', { name: '搜索' }));
    await waitFor(() => expect(ApiClient.prototype.dataCenter).toHaveBeenLastCalledWith(expect.objectContaining({ from: '2026-09-01', to: '2026-09-08', categoryCode: 'detection', taskTypeCode: 'vehicle', query: '路口' })));
  });
  it('expands leaves, displays details, and confirms audited rebindings', async () => {
    render(<MemoryRouter><DataCenterPage /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: /车辆检测/ }));
    fireEvent.click(await screen.findByRole('button', { name: /路口车辆/ }));
    expect(screen.getByText('审核完成时间')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '修改业务任务' }));
    await screen.findAllByRole('option', { name: '道路车道', hidden: true });
    const selects = screen.getAllByLabelText('业务任务');
    fireEvent.change(selects[selects.length - 1], { target: { value: 't2' } });
    fireEvent.click(screen.getByRole('button', { name: '确认改绑' }));
    await waitFor(() => expect(ApiClient.prototype.bindDataset).toHaveBeenCalledWith('d1', 't2', 't1'));
    expect(window.confirm).toHaveBeenCalled();
  });
  it('reports request failures rather than displaying them as empty data', async () => {
    vi.mocked(ApiClient.prototype.dataCenter).mockRejectedValue(new Error('网络中断'));
    render(<MemoryRouter><DataCenterPage /></MemoryRouter>);
    expect(await screen.findByRole('alert')).toHaveTextContent('网络中断');
    expect(screen.queryByText('暂无符合条件的已审核数据集')).not.toBeInTheDocument();
  });
  it('edits categories without editable codes and creates tasks in their parent', async () => {
    render(<MemoryRouter><TaskCatalogPage /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: '编辑目标检测' }));
    expect(screen.getByLabelText('编码')).toHaveAttribute('readonly');
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '视觉目标' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(ApiClient.prototype.saveCatalog).toHaveBeenCalledWith('category', 'c1', expect.objectContaining({ name: '视觉目标' }), 'c1'));
    fireEvent.click(await screen.findByRole('button', { name: '新增业务任务' }));
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '安全帽检测' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(ApiClient.prototype.saveCatalog).toHaveBeenCalledWith('task', null, expect.objectContaining({ name: '安全帽检测' }), 'c1'));
  });
});
