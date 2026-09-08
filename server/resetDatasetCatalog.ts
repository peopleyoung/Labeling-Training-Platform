import { mkdir, rename, lstat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { loadConfig } from './config';
import { createTaskQueue, type TaskQueue } from './queue';

const cleanupAction = 'dataset.catalog_reset';

// A release operation, deliberately separate from the automatic SQL migrations.
export async function resetDatasetCatalog(pool: Pool, artifactRoot: string, apply: boolean, queue?: TaskQueue) {
  const client = await pool.connect();
  const moved: Array<{ source: string; destination: string }> = [];
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('dataset.catalog_reset'))");
    const completed = await client.query('SELECT id FROM audit_logs WHERE action=$1 LIMIT 1', [cleanupAction]);
    if (completed.rowCount) { await client.query('COMMIT'); return { alreadyCompleted: true }; }
    await client.query('LOCK TABLE datasets, training_jobs, model_versions, conversion_jobs, export_tasks, processing_runs, upload_sessions IN SHARE ROW EXCLUSIVE MODE');
    const datasets = (await client.query<{ id: string; name: string }>('SELECT id,name FROM datasets ORDER BY id')).rows;
    const ids = datasets.map((d) => d.id);
    const training = (await client.query<{ id: string; status: string }>("SELECT id,status FROM training_jobs WHERE config->>'datasetId' = ANY($1::text[])", [ids])).rows;
    const trainingIds = training.map((t) => t.id);
    const models = (await client.query<{ id: string; name: string; version: string }>('SELECT id,name,version FROM model_versions WHERE source_job = ANY($1::text[])', [trainingIds])).rows;
    const conversions = (await client.query<{ id: string; status: string }>('SELECT c.id,c.status FROM conversion_jobs c WHERE EXISTS (SELECT 1 FROM model_versions m WHERE m.id = ANY($1::text[]) AND m.name=c.model_name AND m.version=c.model_version)', [models.map((m) => m.id)])).rows;
    const exports = (await client.query<{ id: string; status: string }>('SELECT id,status FROM export_tasks WHERE dataset_id=ANY($1::text[])', [ids])).rows;
    const processing = (await client.query<{ id: string; status: string }>('SELECT id,status FROM processing_runs WHERE dataset_id=ANY($1::text[])', [ids])).rows;
    const uploads = (await client.query<{ id: string }>('SELECT id FROM upload_sessions WHERE dataset_id=ANY($1::text[])', [ids])).rows;
    const active = [...training, ...conversions, ...exports, ...processing].filter((item) => ['queued', 'running', 'processing'].includes(item.status));
    if (apply && active.length) throw new Error(`存在未结束的任务，请先结束后再清理：${active.map((item) => item.id).join(', ')}`);
    const dirs = [...ids.map((id) => `datasets/${id}`), ...ids, ...exports.map((e) => `exports/${e.id}`), ...training.flatMap((t) => [`training/${t.id}`, `runtime/training/${t.id}`]), ...models.map((m) => `models/${m.id}`), ...conversions.map((c) => `conversions/${c.id}`), ...uploads.map((u) => `upload-sessions/${u.id}`)];
    const root = path.resolve(artifactRoot);
    const recovery = path.join(path.dirname(root), `catalog-reset-recovery-${Date.now()}`);
    const plan = { datasets, trainingIds, modelIds: models.map((m) => m.id), conversionIds: conversions.map((c) => c.id), exportIds: exports.map((e) => e.id), processingIds: processing.map((p) => p.id), activeTaskIds: active.map((t) => t.id), recovery };
    if (!apply) { await client.query('ROLLBACK'); return plan; }
    if (queue) {
      for (const id of trainingIds) for (const target of ['cpu', 'gpu'] as const) await queue.remove('training', id, target);
      for (const id of plan.conversionIds) for (const target of ['cpu', 'gpu'] as const) await queue.remove('conversion', id, target);
      for (const id of plan.exportIds) await queue.remove('export', id);
      for (const id of plan.processingIds) await queue.remove('processing', id, 'cpu');
    }
    for (const relative of [...new Set(dirs)]) {
      if (!/^(?:(?:datasets|exports|training|models|conversions|upload-sessions|runtime\/training)\/)?(?:dataset|export|train|model|convert|upload)-[a-zA-Z0-9-]+$/.test(relative)) throw new Error(`拒绝清理未验证目录：${relative}`);
      const source = path.resolve(root, relative);
      if (!source.startsWith(`${root}${path.sep}`)) throw new Error('制品路径越界');
      try { await lstat(source); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      const destination = path.join(recovery, relative);
      await mkdir(path.dirname(destination), { recursive: true });
      await rename(source, destination);
      moved.push({ source, destination });
    }
    await client.query('DELETE FROM conversion_jobs WHERE id=ANY($1::text[])', [plan.conversionIds]);
    await client.query('DELETE FROM model_versions WHERE id=ANY($1::text[])', [plan.modelIds]);
    await client.query('DELETE FROM training_jobs WHERE id=ANY($1::text[])', [trainingIds]);
    await client.query("DELETE FROM artifacts WHERE (source_type='training_job' AND source_id=ANY($1::text[])) OR (source_type='conversion_job' AND source_id=ANY($2::text[])) OR (source_type='export_task' AND source_id=ANY($3::text[])) OR (source_type='model_upload' AND source_id=ANY($4::text[]))", [trainingIds, plan.conversionIds, plan.exportIds, plan.modelIds]);
    await client.query('DELETE FROM datasets WHERE id=ANY($1::text[])', [ids]);
    await client.query('INSERT INTO audit_logs(actor_id,action,entity_type,metadata) VALUES(NULL,$1,$2,$3)', [cleanupAction, 'dataset', JSON.stringify({ ...plan, moved })]);
    await client.query('COMMIT');
    return { ...plan, removedDatasets: ids.length, recoverableDirectories: moved.length };
  } catch (error) {
    await client.query('ROLLBACK');
    for (const item of moved.reverse()) await rename(item.destination, item.source);
    throw error;
  } finally { client.release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = loadConfig();
  if (!config.databaseUrl) throw new Error('DATABASE_URL is required');
  const pool = new Pool({ connectionString: config.databaseUrl });
  const queue = createTaskQueue(config.redisUrl);
  try { console.info(JSON.stringify(await resetDatasetCatalog(pool, config.artifactRoot, process.argv.includes('--apply'), queue), null, 2)); }
  finally { await queue.close(); await pool.end(); }
}
