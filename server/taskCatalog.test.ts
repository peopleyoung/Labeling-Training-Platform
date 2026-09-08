import { describe, expect, it } from 'vitest';
import { MemoryRepository } from './repository';
import { creationBounds, dataCenterQuerySchema } from '../shared/taskCatalog';

async function fixture() {
  const repository = new MemoryRepository({ datasets: [
    { id: 'one', name: '早间数据', description: '', version: 'v1', images: 2, annotated: 2, classes: [], size: '1 KB', status: '可训练', createdAt: '2026-09-08T00:00:00.000Z', updatedAt: '2026-09-08T00:00:00.000Z' },
    { id: 'two', name: '晚间数据', description: '', version: 'v2', images: 3, annotated: 3, classes: [], size: '1 KB', status: '可训练', createdAt: '2026-09-08T23:59:59.999Z', updatedAt: '2026-09-08T23:59:59.999Z' },
    { id: 'three', name: '次日数据', description: '', version: 'v1', images: 1, annotated: 1, classes: [], size: '1 KB', status: '可训练', createdAt: '2026-09-09T00:00:00.000Z', updatedAt: '2026-09-09T00:00:00.000Z' },
    { id: 'draft', name: '待审核', description: '', version: 'v1', images: 1, annotated: 1, classes: [], size: '1 KB', status: '待审核', createdAt: '2026-09-08T12:00:00.000Z', updatedAt: '2026-09-08T12:00:00.000Z' },
  ] });
  const category = (await repository.catalog.list()).categories[0];
  const task = await repository.catalog.save('task', null, { name: '车辆检测' }, 'admin', category.id);
  for (const id of ['one', 'two', 'three', 'draft']) await repository.catalog.bind(id, task.id, null, 'admin');
  return { repository, category, task };
}

describe('global task catalog and data tree', () => {
  it('starts with five editable categories and no business tasks', async () => {
    const repository = new MemoryRepository();
    const catalog = await repository.catalog.list();
    expect(catalog.categories).toHaveLength(5);
    expect(catalog.taskTypes).toEqual([]);
    const first = catalog.categories[0];
    const updated = await repository.catalog.save('category', first.id, { name: '新的大类', enabled: false }, 'admin');
    expect(updated).toMatchObject({ code: first.code, name: '新的大类', enabled: false });
  });
  it('reserves disabled names and prevents binding through disabled parents', async () => {
    const { repository, category, task } = await fixture();
    await repository.catalog.save('task', task.id, { enabled: false }, 'admin');
    await expect(repository.catalog.save('task', null, { name: task.name }, 'admin', category.id)).rejects.toThrow('名称必须唯一');
    await expect(repository.catalog.bind('one', task.id, task.id, 'admin')).rejects.toThrow('启用');
    await repository.catalog.save('task', task.id, { enabled: true }, 'admin');
    await repository.catalog.save('category', category.id, { enabled: false }, 'admin');
    await expect(repository.catalog.assertBindable(task.id)).rejects.toThrow('启用');
    expect((await repository.catalog.tree(dataCenterQuerySchema.parse({}))).total).toBe(3);
  });
  it('counts the full filtered result while paging leaves and includes the end date', async () => {
    const { repository, task, category } = await fixture();
    const query = dataCenterQuerySchema.parse({ from: '2026-09-08', to: '2026-09-08', categoryCode: category.code, taskTypeCode: task.code, pageSize: 1 });
    const first = await repository.catalog.tree(query);
    expect(first.total).toBe(2);
    expect(first.taskTypes[0].datasetCount).toBe(2);
    expect(first.categories[0].datasetCount).toBe(2);
    expect(first.items.map((d) => d.id)).toEqual(['two']);
    expect((await repository.catalog.tree({ ...query, page: 2 })).items.map((d) => d.id)).toEqual(['one']);
    expect((await repository.catalog.tree({ ...query, query: 'v2' })).total).toBe(1);
  });
  it('rejects stale rebindings and audits successful changes', async () => {
    const { repository, task, category } = await fixture();
    const next = await repository.catalog.save('task', null, { name: '新任务' }, 'admin', category.id);
    await expect(repository.catalog.bind('one', next.id, null, 'admin')).rejects.toThrow('其他用户');
    await repository.catalog.bind('one', next.id, task.id, 'admin');
    expect((await repository.getDataset('one'))?.taskTypeId).toBe(next.id);
    expect((await repository.listRecentActivities(50)).some((a) => a.action === 'dataset.task_type.update' && a.metadata.taskTypeId === next.id)).toBe(true);
  });
  it('validates calendar dates and translates local day boundaries', () => {
    expect(dataCenterQuerySchema.safeParse({ from: '2026-02-30' }).success).toBe(false);
    expect(dataCenterQuerySchema.safeParse({ from: '2026-09-09', to: '2026-09-08' }).success).toBe(false);
    expect(creationBounds({ from: '2026-09-08', to: '2026-09-08', timezoneOffset: -480 })).toEqual({ from: '2026-09-07T16:00:00.000Z', until: '2026-09-08T16:00:00.000Z' });
  });
});
