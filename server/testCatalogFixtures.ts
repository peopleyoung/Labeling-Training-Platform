import type { Repository } from './repository';

export async function createTestTaskType(repository: Repository) {
  const category = (await repository.catalog.list()).categories[0];
  const task = await repository.catalog.save('task', null, { name: '测试任务' }, 'test-admin', category.id);
  return task.id;
}
