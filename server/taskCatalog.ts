import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { Dataset } from '../shared/contracts';
import { creationBounds, initialCategoryNames, type BusinessTask, type CatalogInput, type DataCenterQuery, type DataCenterResult, type TaskCatalog, type TaskCategory } from '../shared/taskCatalog';
import { RepositoryConflictError, RepositoryStateError } from './errors';

export interface CatalogRepository {
  list(): Promise<TaskCatalog>;
  save(kind: 'category' | 'task', id: string | null, input: Partial<CatalogInput>, actorId: string, categoryId?: string): Promise<TaskCategory>;
  assertBindable(taskTypeId: string): Promise<void>;
  bind(datasetId: string, taskTypeId: string, expected: string | null, actorId: string): Promise<void>;
  tree(input: DataCenterQuery): Promise<DataCenterResult>;
}

export function generateCatalogCode(name: string, kind: 'category' | 'task') {
  const slug = name.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 60) || kind;
  return `${slug}-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}
const unavailable = () => new RepositoryStateError('TASK_TYPE_UNAVAILABLE', '请选择启用中的大类和业务任务');
const missing = () => new RepositoryStateError('CATALOG_NOT_FOUND', '目录或数据集不存在');
const order = (a: TaskCategory, b: TaskCategory) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code);
function category(row: Record<string, unknown>): TaskCategory {
  return { id: String(row.id), code: String(row.code), name: String(row.name), description: String(row.description), sortOrder: Number(row.sort_order), enabled: Boolean(row.enabled), createdAt: new Date(row.created_at as string | Date).toISOString() };
}
function task(row: Record<string, unknown>): BusinessTask {
  return { ...category(row), categoryId: String(row.category_id), datasetCount: Number(row.dataset_count ?? 0) };
}

export class PgCatalogRepository implements CatalogRepository {
  constructor(private readonly pool: Pool, private readonly mapDataset: (row: Record<string, unknown>) => Dataset, private readonly refresh: (client: PoolClient) => Promise<void>) {}

  async list(): Promise<TaskCatalog> {
    const categories = await this.pool.query('SELECT * FROM task_categories ORDER BY sort_order, code');
    const tasks = await this.pool.query('SELECT t.*, (SELECT COUNT(*) FROM datasets d WHERE d.task_type_id = t.id) AS dataset_count FROM task_types t ORDER BY sort_order, code');
    return { categories: categories.rows.map(category), taskTypes: tasks.rows.map(task) };
  }

  private async audit(client: PoolClient, actorId: string, action: string, entityType: string, entityId: string, metadata: unknown) {
    await client.query('INSERT INTO audit_logs(actor_id, action, entity_type, entity_id, metadata) VALUES ($1,$2,$3,$4,$5)', [actorId, action, entityType, entityId, JSON.stringify(metadata)]);
  }

  async save(kind: 'category' | 'task', id: string | null, input: Partial<CatalogInput>, actorId: string, categoryId?: string): Promise<TaskCategory> {
    const client = await this.pool.connect();
    const table = kind === 'category' ? 'task_categories' : 'task_types';
    try {
      await client.query('BEGIN');
      if (kind === 'task' && !id) {
        const parent = await client.query('SELECT id FROM task_categories WHERE id = $1 AND enabled FOR SHARE', [categoryId]);
        if (!parent.rowCount) throw unavailable();
      }
      let row: Record<string, unknown>;
      if (id) {
        const current = await client.query(`SELECT * FROM ${table} WHERE id = $1 FOR UPDATE`, [id]);
        if (!current.rowCount) throw missing();
        const before = category(current.rows[0]);
        const next = { ...before, ...input };
        const result = await client.query(`UPDATE ${table} SET name=$2, description=$3, sort_order=$4, enabled=$5, updated_at=NOW() WHERE id=$1 RETURNING *`, [id, next.name, next.description, next.sortOrder, next.enabled]);
        row = result.rows[0];
        await this.audit(client, actorId, `catalog.${kind}.update`, table, id, { before, after: category(row) });
      } else {
        const newId = `${kind}-${randomUUID()}`;
        const code = generateCatalogCode(input.name ?? kind, kind);
        const values: unknown[] = [newId, code, input.name, input.description ?? '', input.sortOrder ?? 0, input.enabled ?? true];
        if (kind === 'task') values.push(categoryId);
        const result = await client.query(`INSERT INTO ${table}(id,code,name,description,sort_order,enabled${kind === 'task' ? ',category_id' : ''}) VALUES ($1,$2,$3,$4,$5,$6${kind === 'task' ? ',$7' : ''}) RETURNING *`, values);
        row = result.rows[0];
        await this.audit(client, actorId, `catalog.${kind}.create`, table, newId, category(row));
      }
      await client.query('COMMIT');
      return category(row);
    } catch (error) {
      await client.query('ROLLBACK');
      if ((error as { code?: string }).code === '23505') throw new RepositoryConflictError('名称或编码已存在，请使用其他名称或重试');
      throw error;
    } finally { client.release(); }
  }

  async assertBindable(taskTypeId: string) {
    const result = await this.pool.query('SELECT t.id FROM task_types t JOIN task_categories c ON c.id=t.category_id WHERE t.id=$1 AND t.enabled AND c.enabled', [taskTypeId]);
    if (!result.rowCount) throw unavailable();
  }

  async bind(datasetId: string, taskTypeId: string, expected: string | null, actorId: string) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const target = await client.query('SELECT t.id FROM task_types t JOIN task_categories c ON c.id=t.category_id WHERE t.id=$1 AND t.enabled AND c.enabled FOR SHARE OF t,c', [taskTypeId]);
      if (!target.rowCount) throw unavailable();
      const current = await client.query('SELECT task_type_id FROM datasets WHERE id=$1 FOR UPDATE', [datasetId]);
      if (!current.rowCount) throw missing();
      if (current.rows[0].task_type_id !== expected) throw new RepositoryConflictError();
      await client.query('UPDATE datasets SET task_type_id=$2, updated_at=NOW() WHERE id=$1', [datasetId, taskTypeId]);
      await this.audit(client, actorId, 'dataset.task_type.update', 'dataset', datasetId, { previousTaskTypeId: expected, taskTypeId });
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }

  async tree(input: DataCenterQuery, attempt = 0): Promise<DataCenterResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await this.refresh(client);
      const bounds = creationBounds(input);
      const values: unknown[] = [];
      const conditions = ["d.status = '可训练'", 'd.task_type_id IS NOT NULL', 'd.images > 0'];
      const filter = (sql: string, value: unknown) => { values.push(value); conditions.push(sql.replace('?', `$${values.length}`)); };
      if (bounds.from) filter('d.created_at >= ?::timestamptz', bounds.from);
      if (bounds.until) filter('d.created_at < ?::timestamptz', bounds.until);
      if (input.categoryCode) filter('c.code = ?', input.categoryCode);
      if (input.taskTypeCode) filter('t.code = ?', input.taskTypeCode);
      if (input.query) filter("POSITION(lower(?) IN lower(d.name || ' ' || d.version)) > 0", input.query);
      const from = `FROM datasets d JOIN task_types t ON t.id=d.task_type_id JOIN task_categories c ON c.id=t.category_id WHERE ${conditions.join(' AND ')}`;
      const counts = await client.query(`SELECT t.id, COUNT(*)::integer AS count ${from} GROUP BY t.id`, values);
      const countMap = new Map<string, number>(counts.rows.map((row) => [String(row.id), Number(row.count)]));
      const categories = await client.query('SELECT * FROM task_categories ORDER BY sort_order, code');
      const tasks = await client.query('SELECT * FROM task_types ORDER BY sort_order, code');
      const taskTypes = tasks.rows.map(task).filter((item) => countMap.has(item.id)).map((item) => ({ ...item, datasetCount: countMap.get(item.id)! }));
      const categoryCounts = categories.rows.map(category).map((item) => ({ ...item, datasetCount: taskTypes.filter((t) => t.categoryId === item.id).reduce((sum, t) => sum + t.datasetCount, 0) })).filter((item) => item.datasetCount > 0);
      const items = await client.query(`SELECT d.* ${from} ORDER BY d.created_at DESC, d.id LIMIT $${values.length + 1} OFFSET $${values.length + 2}`, [...values, input.pageSize, (input.page - 1) * input.pageSize]);
      await client.query('COMMIT');
      return { categories: categoryCounts, taskTypes, items: items.rows.map(this.mapDataset), total: [...countMap.values()].reduce((a, b) => a + b, 0), page: input.page, pageSize: input.pageSize };
    } catch (error) {
      await client.query('ROLLBACK');
      // Review transitions can race with the snapshot used for counts and leaves.
      if ((error as { code?: string }).code === '40001' && attempt < 2) return this.tree(input, attempt + 1);
      throw error;
    } finally { client.release(); }
  }
}

export class MemoryCatalogRepository implements CatalogRepository {
  private categories: TaskCategory[] = initialCategoryNames.map((name, i) => ({ id: `category-${i}`, code: generateCatalogCode(name, 'category'), name, description: '', enabled: true, sortOrder: i, createdAt: new Date().toISOString() }));
  private taskTypes: BusinessTask[] = [];
  constructor(private readonly datasets: () => Dataset[], private readonly audit: (actorId: string, action: string, entityId: string, metadata: Record<string, unknown>) => Promise<void>) {}
  async list(): Promise<TaskCatalog> {
    return structuredClone({ categories: [...this.categories].sort(order), taskTypes: [...this.taskTypes].sort(order).map((item) => ({ ...item, datasetCount: this.datasets().filter((d) => d.taskTypeId === item.id).length })) });
  }
  async save(kind: 'category' | 'task', id: string | null, input: Partial<CatalogInput>, actorId: string, categoryId?: string): Promise<TaskCategory> {
    const list = kind === 'category' ? this.categories : this.taskTypes;
    const current = id ? list.find((item) => item.id === id) : undefined;
    if (id && !current) throw missing();
    if (kind === 'task' && !id && !this.categories.some((item) => item.id === categoryId && item.enabled)) throw unavailable();
    const parentId = current && 'categoryId' in current ? current.categoryId : categoryId;
    if (kind === 'task' && this.taskTypes.some((item) => item.id !== id && item.categoryId === parentId && item.name === (input.name ?? current?.name))) throw new RepositoryConflictError('同一大类下业务任务名称必须唯一');
    const next = { id: `${kind}-${randomUUID()}`, code: generateCatalogCode(input.name ?? kind, kind), name: '', description: '', sortOrder: 0, enabled: true, createdAt: new Date().toISOString(), ...current, ...input };
    if (current) Object.assign(current, next);
    else if (kind === 'category') this.categories.push(next);
    else this.taskTypes.push({ ...next, categoryId: categoryId!, datasetCount: 0 });
    await this.audit(actorId, `catalog.${kind}.${id ? 'update' : 'create'}`, next.id, { ...next });
    return structuredClone(next);
  }
  async assertBindable(taskTypeId: string) {
    const target = this.taskTypes.find((item) => item.id === taskTypeId && item.enabled);
    if (!target || !this.categories.some((item) => item.id === target.categoryId && item.enabled)) throw unavailable();
  }
  async bind(datasetId: string, taskTypeId: string, expected: string | null, actorId: string) {
    await this.assertBindable(taskTypeId);
    const dataset = this.datasets().find((item) => item.id === datasetId);
    if (!dataset) throw missing();
    if ((dataset.taskTypeId ?? null) !== expected) throw new RepositoryConflictError();
    dataset.taskTypeId = taskTypeId;
    dataset.updatedAt = new Date().toISOString();
    await this.audit(actorId, 'dataset.task_type.update', datasetId, { previousTaskTypeId: expected, taskTypeId });
  }
  async tree(input: DataCenterQuery): Promise<DataCenterResult> {
    const catalog = await this.list();
    const bounds = creationBounds(input);
    const items = this.datasets().filter((d) => {
      const t = catalog.taskTypes.find((item) => item.id === d.taskTypeId);
      const c = catalog.categories.find((item) => item.id === t?.categoryId);
      return d.status === '可训练' && d.images > 0 && t && c && (!bounds.from || Boolean(d.createdAt && d.createdAt >= bounds.from)) && (!bounds.until || Boolean(d.createdAt && d.createdAt < bounds.until)) && (!input.categoryCode || c.code === input.categoryCode) && (!input.taskTypeCode || t.code === input.taskTypeCode) && `${d.name} ${d.version}`.toLowerCase().includes(input.query.toLowerCase());
    }).sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '') || a.id.localeCompare(b.id));
    const taskTypes = catalog.taskTypes.map((t) => ({ ...t, datasetCount: items.filter((d) => d.taskTypeId === t.id).length })).filter((t) => t.datasetCount);
    const categories = catalog.categories.map((c) => ({ ...c, datasetCount: taskTypes.filter((t) => t.categoryId === c.id).reduce((sum, t) => sum + t.datasetCount, 0) })).filter((c) => c.datasetCount);
    return structuredClone({ categories, taskTypes, items: items.slice((input.page - 1) * input.pageSize, input.page * input.pageSize), total: items.length, page: input.page, pageSize: input.pageSize });
  }
}
