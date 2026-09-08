import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { migrate } from './migrate';
import { PgRepository } from './repository';
import { dataCenterQuerySchema } from '../shared/taskCatalog';
import { workspaceId } from './workspace';
import { resetDatasetCatalog } from './resetDatasetCatalog';

const databaseUrl = process.env.CATALOG_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)('PostgreSQL task catalog', () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const repository = new PgRepository(pool);
  let root: string;
  let categoryId: string;
  let taskId: string;
  let datasetId: string;
  beforeAll(async () => {
    await migrate(databaseUrl!);
    root = await mkdtemp(path.join(tmpdir(), 'catalog-pg-'));
    await pool.query('INSERT INTO workspaces(id,name) VALUES($1,$2) ON CONFLICT DO NOTHING', [workspaceId, 'Test']);
    await pool.query("INSERT INTO users(id,workspace_id,username,display_name,password_hash,role,roles) VALUES('catalog-admin',$1,'catalog-admin','Admin','unused','admin','[\"admin\"]')", [workspaceId]);
    categoryId = (await repository.catalog.list()).categories[0].id;
    taskId = (await repository.catalog.save('task', null, { name: '道路目标' }, 'catalog-admin', categoryId)).id;
  });
  afterAll(async () => { await pool.end(); if (root) await rm(root, { recursive: true, force: true }); });

  it('creates bound datasets with actual creation time and reconciles approved data', async () => {
    const dataset = await repository.createDataset({ taskTypeId: taskId, name: '已审核道路', version: 'v1', description: '', classes: [] });
    datasetId = dataset.id;
    expect(dataset.createdAt).toBeTruthy();
    const image = await repository.createDatasetImage({ datasetId, filename: 'frame.png', mimeType: 'image/png', sizeBytes: 10, objectKey: `datasets/${datasetId}/frame.png`, split: 'train' });
    await repository.saveAnnotations({ datasetId, imageId: image.id, revision: 0, annotations: [], updatedBy: 'catalog-admin' });
    await pool.query("UPDATE annotation_documents SET review_status='approved' WHERE dataset_id=$1", [datasetId]);
    await pool.query("UPDATE datasets SET created_at='2026-09-08T23:59:59.999Z' WHERE id=$1", [datasetId]);
    const concurrent = await Promise.all(Array.from({ length: 4 }, () => repository.catalog.tree(dataCenterQuerySchema.parse({ from: '2026-09-08', to: '2026-09-08', pageSize: 1 }))));
    const result = concurrent[0];
    expect(concurrent.map((r) => r.total)).toEqual([1, 1, 1, 1]);
    expect(result.total).toBe(1);
    expect(result.items[0]).toMatchObject({ id: datasetId, taskTypeId: taskId, status: '可训练' });
    expect(result.items[0].approvedAt).toBeTruthy();
    expect(result.taskTypes[0].datasetCount).toBe(1);
    expect((await repository.catalog.tree(dataCenterQuerySchema.parse({ from: '2026-09-09' }))).total).toBe(0);
    await pool.query("UPDATE annotation_documents SET review_status='rejected' WHERE dataset_id=$1", [datasetId]);
    expect((await repository.catalog.tree(dataCenterQuerySchema.parse({}))).total).toBe(0);
    expect((await repository.getDataset(datasetId))?.approvedAt).toBeUndefined();
  });
  it('enforces uniqueness and parent enabled checks at storage boundary', async () => {
    await expect(repository.catalog.save('task', null, { name: '道路目标' }, 'catalog-admin', categoryId)).rejects.toThrow('已存在');
    await repository.catalog.save('category', categoryId, { enabled: false }, 'catalog-admin');
    await expect(repository.createDataset({ taskTypeId: taskId, name: '禁止创建', description: '', version: 'v1', classes: [] })).rejects.toThrow('启用');
    await expect(pool.query('UPDATE datasets SET task_type_id=NULL WHERE id=$1', [datasetId])).rejects.toThrow();
    await repository.catalog.save('category', categoryId, { enabled: true }, 'catalog-admin');
  });
  it('allows one concurrent rebinding and records its audit in the transaction', async () => {
    const second = await repository.catalog.save('task', null, { name: '另一业务' }, 'catalog-admin', categoryId);
    const results = await Promise.allSettled([repository.catalog.bind(datasetId, second.id, taskId, 'catalog-admin'), repository.catalog.bind(datasetId, second.id, taskId, 'catalog-admin')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const audit = await pool.query("SELECT metadata FROM audit_logs WHERE action='dataset.task_type.update' AND entity_id=$1", [datasetId]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].metadata).toMatchObject({ previousTaskTypeId: taskId, taskTypeId: second.id });
  });
  it('previews cleanup, removes database assets once and retains recoverable files', async () => {
    const artifacts = path.join(root, 'artifacts');
    await mkdir(path.join(artifacts, 'datasets', datasetId), { recursive: true });
    await writeFile(path.join(artifacts, 'datasets', datasetId, 'frame.png'), 'test-data');
    await resetDatasetCatalog(pool, artifacts, false);
    expect((await repository.listDatasets()).length).toBe(1);
    await resetDatasetCatalog(pool, artifacts, true);
    expect(await repository.listDatasets()).toEqual([]);
    expect(Number((await pool.query('SELECT COUNT(*) AS count FROM annotation_documents')).rows[0].count)).toBe(0);
    const audit = await pool.query("SELECT metadata FROM audit_logs WHERE action='dataset.catalog_reset'");
    expect(await readFile(path.join(audit.rows[0].metadata.moved[0].destination, 'frame.png'), 'utf8')).toBe('test-data');
    await repository.createDataset({ taskTypeId: taskId, name: '上线后数据', description: '', version: 'v1', classes: [] });
    expect(await resetDatasetCatalog(pool, artifacts, true)).toEqual({ alreadyCompleted: true });
    expect((await repository.listDatasets()).length).toBe(1);
  });
});
