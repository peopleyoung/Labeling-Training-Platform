import { Pool } from 'pg';
import { loadConfig } from './config';
import { findOrphanManagedArtifactDirectories, measureManagedArtifactDirectories, removeManagedArtifactDirectories, removeManagedArtifactFiles, type ManagedStorageReferences } from './artifactCleanup';

interface IdRow { id: string }
interface TrainingRow extends IdRow { status: string; artifact_id: string | null }
interface ModelRow extends IdRow { name: string; version: string; source_job: string; artifact_id: string | null }
interface ConversionRow extends IdRow { model_name: string; model_version: string; status: string; artifact_id: string | null }
interface ExportRow extends IdRow { artifact_id: string | null }
interface ArtifactRow extends IdRow { object_key: string; source_type: string; source_id: string }

interface DatabaseCleanupPlan {
  danglingModelIds: string[];
  orphanConversionIds: string[];
  orphanArtifacts: ArtifactRow[];
  references: ManagedStorageReferences;
}

const terminalStatuses = new Set(['completed', 'failed', 'cancelled']);

async function buildDatabaseCleanupPlan(pool: Pool): Promise<DatabaseCleanupPlan> {
  const [datasetsResult, exportsResult, trainingResult, modelsResult, conversionsResult, artifactsResult] = await Promise.all([
    pool.query<IdRow>('SELECT id FROM datasets'),
    pool.query<ExportRow>('SELECT id, artifact_id FROM export_tasks'),
    pool.query<TrainingRow>('SELECT id, status, artifact_id FROM training_jobs'),
    pool.query<ModelRow>('SELECT id, name, version, source_job, artifact_id FROM model_versions'),
    pool.query<ConversionRow>('SELECT id, model_name, model_version, status, artifact_id FROM conversion_jobs'),
    pool.query<ArtifactRow>('SELECT id, object_key, source_type, source_id FROM artifacts'),
  ]);

  const trainingIds = new Set(trainingResult.rows.map((row) => row.id));
  const conversionsByModel = new Map<string, ConversionRow[]>();
  for (const conversion of conversionsResult.rows) {
    const key = `${conversion.model_name}\u0000${conversion.model_version}`;
    conversionsByModel.set(key, [...(conversionsByModel.get(key) ?? []), conversion]);
  }
  const danglingModels = modelsResult.rows.filter((model) => {
    if (model.source_job === 'manual-upload' || trainingIds.has(model.source_job)) return false;
    return (conversionsByModel.get(`${model.name}\u0000${model.version}`) ?? []).every((conversion) => terminalStatuses.has(conversion.status));
  });
  const danglingModelIds = new Set(danglingModels.map((model) => model.id));
  const retainedModels = modelsResult.rows.filter((model) => !danglingModelIds.has(model.id));
  const retainedModelKeys = new Set(retainedModels.map((model) => `${model.name}\u0000${model.version}`));
  const orphanConversions = conversionsResult.rows.filter((conversion) => terminalStatuses.has(conversion.status) && !retainedModelKeys.has(`${conversion.model_name}\u0000${conversion.model_version}`));
  const orphanConversionIds = new Set(orphanConversions.map((conversion) => conversion.id));
  const retainedConversions = conversionsResult.rows.filter((conversion) => !orphanConversionIds.has(conversion.id));

  const retainedArtifactIds = new Set([
    ...trainingResult.rows.map((row) => row.artifact_id),
    ...retainedModels.map((row) => row.artifact_id),
    ...retainedConversions.map((row) => row.artifact_id),
    ...exportsResult.rows.map((row) => row.artifact_id),
  ].filter((id): id is string => Boolean(id)));
  const datasetIds = new Set(datasetsResult.rows.map((row) => row.id));
  const exportIds = new Set(exportsResult.rows.map((row) => row.id));
  const modelIds = new Set(retainedModels.map((row) => row.id));
  const conversionIds = new Set(retainedConversions.map((row) => row.id));
  const sourceExists = (artifact: ArtifactRow) => {
    if (artifact.source_type === 'training_job') return trainingIds.has(artifact.source_id);
    if (artifact.source_type === 'conversion_job') return conversionIds.has(artifact.source_id);
    if (artifact.source_type === 'export_task') return exportIds.has(artifact.source_id);
    if (artifact.source_type === 'model_upload') return modelIds.has(artifact.source_id);
    return true;
  };
  const orphanArtifacts = artifactsResult.rows.filter((artifact) => !retainedArtifactIds.has(artifact.id) && !sourceExists(artifact));

  return {
    danglingModelIds: [...danglingModelIds].sort(),
    orphanConversionIds: [...orphanConversionIds].sort(),
    orphanArtifacts,
    references: {
      datasets: datasetIds,
      exports: exportIds,
      training: trainingIds,
      conversions: conversionIds,
      models: modelIds,
      activeTraining: new Set(trainingResult.rows.filter((row) => row.status === 'queued' || row.status === 'running').map((row) => row.id)),
    },
  };
}

async function applyDatabaseCleanup(pool: Pool, plan: DatabaseCleanupPlan) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let removedConversions = 0;
    if (plan.orphanConversionIds.length) {
      const result = await client.query("DELETE FROM conversion_jobs WHERE id = ANY($1::text[]) AND status NOT IN ('queued', 'running')", [plan.orphanConversionIds]);
      removedConversions = result.rowCount ?? 0;
    }
    let removedModels = 0;
    if (plan.danglingModelIds.length) {
      const result = await client.query(`
        DELETE FROM model_versions m
        WHERE m.id = ANY($1::text[])
          AND m.source_job <> 'manual-upload'
          AND NOT EXISTS (SELECT 1 FROM training_jobs t WHERE t.id = m.source_job)
          AND NOT EXISTS (
            SELECT 1 FROM conversion_jobs c
            WHERE c.workspace_id = m.workspace_id AND c.model_name = m.name AND c.model_version = m.version
              AND c.status IN ('queued', 'running')
          )
      `, [plan.danglingModelIds]);
      removedModels = result.rowCount ?? 0;
    }
    let removedArtifacts = 0;
    const artifactIds = plan.orphanArtifacts.map((artifact) => artifact.id);
    if (artifactIds.length) {
      const result = await client.query(`
        DELETE FROM artifacts a
        WHERE a.id = ANY($1::text[])
          AND NOT EXISTS (SELECT 1 FROM training_jobs t WHERE t.artifact_id = a.id)
          AND NOT EXISTS (SELECT 1 FROM model_versions m WHERE m.artifact_id = a.id)
          AND NOT EXISTS (SELECT 1 FROM conversion_jobs c WHERE c.artifact_id = a.id)
          AND NOT EXISTS (SELECT 1 FROM export_tasks e WHERE e.artifact_id = a.id)
      `, [artifactIds]);
      removedArtifacts = result.rowCount ?? 0;
    }
    await client.query('INSERT INTO audit_logs(actor_id, action, entity_type, metadata) VALUES (NULL, $1, $2, $3)', ['storage.gc', 'artifact_storage', JSON.stringify({ removedModels, removedConversions, removedArtifacts })]);
    await client.query('COMMIT');
    return { removedModels, removedConversions, removedArtifacts };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function isStillOrphan(pool: Pool, relativeDirectory: string) {
  const parts = relativeDirectory.split('/');
  if (parts.length === 1) {
    const table = relativeDirectory.startsWith('dataset-') ? 'datasets'
      : relativeDirectory.startsWith('export-') ? 'export_tasks'
        : relativeDirectory.startsWith('train-') ? 'training_jobs'
          : relativeDirectory.startsWith('convert-') ? 'conversion_jobs'
            : relativeDirectory.startsWith('model-') ? 'model_versions'
              : null;
    if (!table) return false;
    const result = await pool.query(`SELECT 1 FROM ${table} WHERE id = $1`, [relativeDirectory]);
    return result.rowCount === 0;
  }
  if (parts[0] === 'runtime' && parts[1] === 'training') {
    const result = await pool.query("SELECT 1 FROM training_jobs WHERE id = $1 AND status IN ('queued', 'running')", [parts[2]]);
    return result.rowCount === 0;
  }
  const table = { datasets: 'datasets', exports: 'export_tasks', training: 'training_jobs', conversions: 'conversion_jobs', models: 'model_versions' }[parts[0]];
  if (!table) return false;
  const result = await pool.query(`SELECT 1 FROM ${table} WHERE id = $1`, [parts[1]]);
  return result.rowCount === 0;
}

async function main() {
  const execute = process.argv.includes('--execute');
  const config = loadConfig();
  if (!config.databaseUrl) throw new Error('DATABASE_URL is required for artifact cleanup');
  const pool = new Pool({ connectionString: config.databaseUrl, max: 2 });
  try {
    const initialPlan = await buildDatabaseCleanupPlan(pool);
    const orphanDirectories = await findOrphanManagedArtifactDirectories(config.artifactRoot, initialPlan.references);
    const directoryDetails = await measureManagedArtifactDirectories(config.artifactRoot, orphanDirectories);
    const report = {
      mode: execute ? 'execute' : 'dry-run',
      artifactRoot: config.artifactRoot,
      database: {
        danglingModelIds: initialPlan.danglingModelIds,
        orphanConversionIds: initialPlan.orphanConversionIds,
        orphanArtifactIds: initialPlan.orphanArtifacts.map((artifact) => artifact.id),
      },
      storage: {
        directories: directoryDetails,
        totalBytes: directoryDetails.reduce((total, item) => total + item.bytes, 0),
      },
    };
    if (!execute) {
      console.info(JSON.stringify(report, null, 2));
      return;
    }

    const database = await applyDatabaseCleanup(pool, initialPlan);
    const refreshedPlan = await buildDatabaseCleanupPlan(pool);
    const refreshedCandidates = await findOrphanManagedArtifactDirectories(config.artifactRoot, refreshedPlan.references);
    const confirmedCandidates: string[] = [];
    for (const candidate of refreshedCandidates) if (await isStillOrphan(pool, candidate)) confirmedCandidates.push(candidate);
    const files = await removeManagedArtifactFiles(config.artifactRoot, initialPlan.orphanArtifacts.map((artifact) => artifact.object_key));
    const directories = await removeManagedArtifactDirectories(config.artifactRoot, confirmedCandidates);
    console.info(JSON.stringify({ ...report, database, storage: { files, directories, removedPaths: confirmedCandidates } }, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
