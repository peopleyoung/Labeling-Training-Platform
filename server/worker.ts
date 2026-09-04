import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import { Pool } from 'pg';
import { artifactObjectKey, artifactTaskDirectory, type WorkerArtifactCategory } from './artifacts';
import { loadConfig } from './config';
import { createDatasetExport } from './datasetExport';
import { prepareTrainingFormat } from './trainingFormats';
import { metricsFromRunnerEvent, parseRunnerEvent, parseYoloResultsCsv, type RunnerEvent, type TrainingMetricInput } from './trainingObservability';
import { buildSegments } from './mediaProcessing';
import { createThumbnail, describeImageFile, extractArchiveImages, extractVideoFrames, type ProcessedMediaFile } from './mediaProcessor';

type QueueKind = 'training' | 'conversion' | 'export' | 'processing';

class RunnerCancelledError extends Error {
  constructor() {
    super('Runner was cancelled');
    this.name = 'RunnerCancelledError';
  }
}

const config = loadConfig();
if (!config.databaseUrl || !config.redisUrl) throw new Error('DATABASE_URL and REDIS_URL are required for the worker');

const pool = new Pool({ connectionString: config.databaseUrl });
const connection = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });
const artifactRoot = process.env.FORGE_ARTIFACT_ROOT ?? '/data/artifacts';
const queueName = process.env.FORGE_QUEUE_NAME ?? 'forge-gpu';
const executionDevice = process.env.FORGE_EXECUTION_DEVICE === 'cpu' ? 'cpu' : 'gpu';
const executionLabel = executionDevice === 'cpu' ? 'CPU Worker' : 'GPU Worker';

async function appendTrainingEvent(jobId: string, workspaceId: string, level: 'info' | 'warning' | 'error', message: string) {
  await pool.query('INSERT INTO training_events(workspace_id, job_id, level, message) VALUES ($1,$2,$3,$4)', [workspaceId, jobId, level, message]);
}

function stopProcessTree(child: ReturnType<typeof spawn>, signal: NodeJS.Signals) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') console.error(`Failed to send ${signal} to runner process tree`, error);
  }
}

function runPython(task: Record<string, unknown>, onEvent?: (event: RunnerEvent) => Promise<void>, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new RunnerCancelledError());
      return;
    }
    const child = spawn('python3', ['-m', 'forge_worker.runner'], {
      detached: process.platform !== 'win32',
      env: { ...process.env, FORGE_EXECUTION_DEVICE: executionDevice, FORGE_TASK_JSON: JSON.stringify(task), PYTHONPATH: `${process.cwd()}/worker` },
    });
    let outputTail = '';
    let stdoutBuffer = '';
    let eventWrites = Promise.resolve();
    let cancelled = false;
    let forceKillTimer: NodeJS.Timeout | undefined;
    const cancel = () => {
      if (cancelled) return;
      cancelled = true;
      stopProcessTree(child, 'SIGTERM');
      forceKillTimer = setTimeout(() => stopProcessTree(child, 'SIGKILL'), 5_000);
      forceKillTimer.unref();
    };
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    const cleanup = () => {
      signal?.removeEventListener('abort', cancel);
      if (forceKillTimer) clearTimeout(forceKillTimer);
    };
    const consumeLines = (chunk: string, flush = false) => {
      const parts = `${stdoutBuffer}${chunk}`.split(/[\r\n]+/);
      stdoutBuffer = flush ? '' : (parts.pop() ?? '');
      for (const line of parts) {
        const event = parseRunnerEvent(line);
        if (event && onEvent) {
          eventWrites = eventWrites.then(() => onEvent(event)).catch((error: unknown) => {
            console.error('Failed to persist runner event', error);
          });
        }
      }
    };
    child.stdout.on('data', (chunk: Buffer) => {
      process.stdout.write(chunk);
      const text = chunk.toString();
      outputTail = `${outputTail}${text}`.slice(-4000);
      consumeLines(text);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk);
      outputTail = `${outputTail}${chunk.toString()}`.slice(-4000);
    });
    child.on('error', (error) => {
      cleanup();
      reject(error);
    });
    child.on('close', (code) => {
      cleanup();
      consumeLines('', true);
      void eventWrites.finally(() => cancelled ? reject(new RunnerCancelledError()) : code === 0 ? resolve() : reject(new Error(outputTail.trim() || `Python runner exited with code ${code}`)));
    });
  });
}

function artifactDir(category: WorkerArtifactCategory, taskId: string) {
  return artifactTaskDirectory(artifactRoot, category, taskId);
}

async function trainingJobCancelled(taskId: string) {
  const result = await pool.query('SELECT status FROM training_jobs WHERE id = $1', [taskId]);
  return result.rows[0]?.status === 'cancelled';
}

async function cleanupCancelledTraining(taskId: string, outputDir: string) {
  await Promise.all([
    rm(outputDir, { recursive: true, force: true }),
    rm(path.join(artifactRoot, 'runtime', 'training', taskId), { recursive: true, force: true }),
  ]);
}

async function sha256File(filePath: string) {
  const hash = createHash('sha256');
  const file = await import('node:fs');
  await new Promise<void>((resolve, reject) => {
    const stream = file.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(root, entry.name);
    return entry.isDirectory() ? listFiles(entryPath) : [entryPath];
  }));
  return files.flat();
}

async function pickTrainingArtifact(outputDir: string) {
  const files = await listFiles(outputDir);
  return files.find((file) => /[/\\]weights[/\\]best\.pt$/i.test(file))
    ?? files.find((file) => /[/\\]weights[/\\]last\.pt$/i.test(file))
    ?? files.find((file) => path.basename(file) === 'model.torchscript.pt')
    ?? files.find((file) => file.endsWith('.safetensors'))
    ?? files.find((file) => file.endsWith('.zip'))
    ?? files.find((file) => file.endsWith('.pt'))
    ?? null;
}

async function readYoloMetric(outputDir: string, model: string) {
  const resultsFile = (await listFiles(outputDir)).find((file) => path.basename(file) === 'results.csv');
  if (!resultsFile) return null;
  const lines = (await readFile(resultsFile, 'utf8')).trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return null;
  const headers = lines[0].split(',').map((value) => value.trim().toLowerCase());
  const values = lines.at(-1)?.split(',').map((value) => value.trim()) ?? [];
  const metricSuffix = model.endsWith('-seg') ? '(m)' : model.endsWith('-pose') ? '(p)' : '(b)';
  const preferredIndex = headers.findIndex((header) => header.includes('map50') && header.endsWith(metricSuffix));
  const index = preferredIndex >= 0 ? preferredIndex : headers.findIndex((header) => (header.includes('map50') || header.includes('map_0.5')) && !header.includes('95') && !header.includes('0.5:0.95'));
  const value = index >= 0 ? Number(values[index]) : Number.NaN;
  return Number.isFinite(value) ? { value, epochs: lines.length - 1 } : null;
}

async function readTrainingMetric(outputDir: string) {
  const metricsFile = (await listFiles(outputDir)).find((file) => path.basename(file) === 'metrics.json');
  if (!metricsFile) return null;
  const metrics = JSON.parse(await readFile(metricsFile, 'utf8')) as { metricValue?: unknown; epochs?: unknown };
  const value = Number(metrics.metricValue);
  const epochs = Number(metrics.epochs);
  return Number.isFinite(value) ? { value, epochs: Number.isInteger(epochs) && epochs > 0 ? epochs : 0 } : null;
}

function metricNameForModel(type: string, model?: string) {
  if (model?.endsWith('-seg') || model?.endsWith('-pose')) return 'mAP@50';
  if (type === 'detection') return 'mAP@50';
  if (type === 'segmentation') return 'mIoU';
  if (type === 'keypoint') return 'OKS';
  if (type === 'sdxl') return 'Loss';
  return 'mAP@50';
}

function primaryMetric(type: string, metrics: Record<string, number>, model?: string) {
  if (model?.endsWith('-seg') || model?.endsWith('-pose')) return metrics.mAP50;
  if (type === 'detection') return metrics.mAP50;
  if (type === 'segmentation') return metrics.mIoU;
  if (type === 'keypoint') return metrics.oks;
  if (type === 'sdxl') return metrics.loss;
  return undefined;
}

async function persistTrainingMetric(input: {
  jobId: string;
  workspaceId: string;
  type: string;
  model?: string;
  totalEpochs: number;
  point: TrainingMetricInput;
  progress: number;
  announce: boolean;
}) {
  const progress = Math.max(15, Math.min(90, Math.round(input.progress)));
  await pool.query(
    `INSERT INTO training_metrics(workspace_id, job_id, epoch, progress, metrics)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (job_id, epoch) DO UPDATE
     SET progress = EXCLUDED.progress, metrics = EXCLUDED.metrics, updated_at = NOW()`,
    [input.workspaceId, input.jobId, input.point.epoch, progress, JSON.stringify(input.point.metrics)],
  );
  const metric = primaryMetric(input.type, input.point.metrics, input.model);
  await pool.query(
    "UPDATE training_jobs SET progress = GREATEST(progress, $2), epoch = $3, metric_value = COALESCE($4, metric_value), eta = $5, updated_at = NOW() WHERE id = $1 AND status = 'running'",
    [input.jobId, progress, `${input.point.epoch} / ${input.totalEpochs}`, metric === undefined ? null : metric.toFixed(4), `Epoch ${input.point.epoch} / ${input.totalEpochs}`],
  );
  if (input.announce) {
    const metricText = metric === undefined ? `loss=${input.point.metrics.loss?.toFixed(4) ?? '--'}` : `${metricNameForModel(input.type, input.model)}=${metric.toFixed(4)}`;
    await appendTrainingEvent(input.jobId, input.workspaceId, 'info', `Epoch ${input.point.epoch}/${input.totalEpochs} · ${metricText}`);
  }
}

async function persistResourceSample(jobId: string, workspaceId: string, event: RunnerEvent) {
  const cpuPercent = Number(event.cpuPercent);
  const memoryUsedMb = Number(event.memoryUsedMb);
  if (!Number.isFinite(cpuPercent) || !Number.isFinite(memoryUsedMb)) return;
  const optional = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : null;
  await pool.query(
    `INSERT INTO training_resource_samples(workspace_id, job_id, device, cpu_percent, memory_used_mb, memory_total_mb, gpu_percent, gpu_memory_used_mb, gpu_memory_total_mb, gpu_power_watts)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [workspaceId, jobId, event.device === 'gpu' ? 'gpu' : 'cpu', cpuPercent, memoryUsedMb, optional(event.memoryTotalMb), optional(event.gpuPercent), optional(event.gpuMemoryUsedMb), optional(event.gpuMemoryTotalMb), optional(event.gpuPowerWatts)],
  );
}

function modelFamily(model: string) {
  const normalized = model.toLowerCase();
  if (normalized.startsWith('yolov8') && normalized.endsWith('-seg')) return 'yolov8-seg';
  if (normalized.startsWith('yolov8') && normalized.endsWith('-pose')) return 'yolov8-pose';
  if (normalized.includes('yolov5')) return 'yolov5';
  if (normalized.includes('yolov8')) return 'yolov8';
  if (normalized.includes('segformer')) return 'segformer';
  if (normalized.includes('deeplabv3')) return 'deeplabv3plus';
  if (normalized.includes('unet') || normalized.includes('u-net')) return 'unet';
  if (normalized.includes('higherhrnet')) return 'higherhrnet';
  if (normalized.includes('hrnet')) return 'hrnet';
  if (normalized.includes('sdxl') || normalized.includes('stable diffusion xl')) return 'sdxl';
  return 'unknown';
}

function frameworkFor(model: string) {
  const family = modelFamily(model);
  if (family === 'yolov5') return 'Ultralytics YOLOv5u / PyTorch';
  if (family === 'yolov8') return 'Ultralytics YOLOv8 / PyTorch';
  if (family === 'yolov8-seg') return 'Ultralytics YOLOv8-Seg / PyTorch';
  if (family === 'yolov8-pose') return 'Ultralytics YOLOv8-Pose / PyTorch';
  if (family === 'segformer') return 'Transformers SegFormer / PyTorch';
  if (family === 'deeplabv3plus') return 'DeepLabV3+ / PyTorch';
  if (family === 'unet') return 'U-Net / PyTorch';
  if (family === 'higherhrnet') return 'HigherHRNet / PyTorch';
  if (family === 'hrnet') return 'HRNet / PyTorch';
  if (family === 'sdxl') return 'Diffusers SDXL LoRA / PyTorch';
  return 'PyTorch';
}

function formatBytes(value: number) {
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}

async function registerArtifact(input: {
  workspaceId: string;
  filePath: string;
  mimeType: string;
  sourceType: string;
  sourceId: string;
  createdBy: string | null;
}) {
  const fileStats = await stat(input.filePath);
  const artifactId = `artifact-${randomUUID()}`;
  const digest = await sha256File(input.filePath);
  const objectKey = artifactObjectKey(artifactRoot, input.filePath);
  await pool.query(
    'INSERT INTO artifacts(id, workspace_id, object_key, filename, mime_type, size_bytes, sha256, source_type, source_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [artifactId, input.workspaceId, objectKey, path.basename(input.filePath), input.mimeType, fileStats.size, digest, input.sourceType, input.sourceId, input.createdBy],
  );
  return { id: artifactId, sizeBytes: fileStats.size };
}

async function handleTraining(taskId: string) {
  const result = await pool.query("SELECT j.id, j.workspace_id, j.name, j.type, j.model, j.config, j.snapshot_id, j.created_by, j.status, d.id AS dataset_id, d.classes FROM training_jobs j JOIN datasets d ON d.id = j.config->>'datasetId' WHERE j.id = $1", [taskId]);
  const job = result.rows[0];
  if (!job) throw new Error(`Training job ${taskId} was not found`);
  if (job.status === 'cancelled') return;
  const started = await pool.query("UPDATE training_jobs SET status = 'running', eta = $2, updated_at = NOW() WHERE id = $1 AND status IN ('queued', 'running') RETURNING id", [taskId, `${executionLabel} 正在启动`]);
  if (!started.rowCount) return;
  await appendTrainingEvent(taskId, job.workspace_id, 'info', `${executionLabel} 已接收任务，准备启动 ${job.model}`);
  const outputDir = artifactDir('training', taskId);
  const datasetDir = path.join(artifactRoot, 'runtime', 'training', taskId, 'dataset');
  await rm(outputDir, { recursive: true, force: true });
  await rm(datasetDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  const snapshotResult = await pool.query('SELECT snapshot FROM training_snapshots WHERE id = $1', [job.snapshot_id]);
  if (!snapshotResult.rowCount) throw new Error(`Training snapshot ${job.snapshot_id} was not found`);
  const snapshot = snapshotResult.rows[0].snapshot;
  const prepared = await prepareTrainingFormat({
    artifactRoot,
    outputDir: datasetDir,
    task: job.type,
    format: job.config.dataFormat,
    dataset: { id: job.dataset_id, name: job.name, version: 'training', classes: Array.isArray(job.classes) ? job.classes : [] },
    images: snapshot.images,
    documents: snapshot.documents.map((document: Record<string, unknown>) => ({ imageId: document.imageId, annotations: document.annotations, captions: document.captions, imageAttributes: document.imageAttributes })),
  });
  const datasetConfig = prepared.configPath;
  await pool.query("UPDATE training_jobs SET progress = 10, eta = '数据集已就绪', updated_at = NOW() WHERE id = $1 AND status = 'running'", [taskId]);
  await appendTrainingEvent(taskId, job.workspace_id, 'info', `${prepared.format} 训练数据已生成并验证：${prepared.imageCount} 张图片，${prepared.classes.length} 个类别`);
  if (await trainingJobCancelled(taskId)) {
    await cleanupCancelledTraining(taskId, outputDir);
    return;
  }
  await pool.query("UPDATE training_jobs SET progress = 15, eta = '正在训练', updated_at = NOW() WHERE id = $1 AND status = 'running'", [taskId]);
  const totalEpochs = Number(job.config.epochs);
  let reportedEpoch = 0;
  let polling = false;
  const persistYoloMetrics = async () => {
    if (polling || !['yolov5', 'yolov8', 'yolov8-seg', 'yolov8-pose'].includes(modelFamily(job.model))) return;
    polling = true;
    try {
      const csv = await readFile(path.join(outputDir, 'run', 'results.csv'), 'utf8');
      for (const point of parseYoloResultsCsv(csv)) {
        const announce = point.epoch > reportedEpoch;
        await persistTrainingMetric({ jobId: taskId, workspaceId: job.workspace_id, type: job.type, model: job.model, totalEpochs, point, progress: 15 + point.epoch * 70 / totalEpochs, announce });
        reportedEpoch = Math.max(reportedEpoch, point.epoch);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    } finally {
      polling = false;
    }
  };
  const metricTimer = ['yolov5', 'yolov8', 'yolov8-seg', 'yolov8-pose'].includes(modelFamily(job.model)) ? setInterval(() => void persistYoloMetrics().catch((error) => console.error('Failed to persist YOLO metrics', error)), 3000) : null;
  const cancellation = new AbortController();
  let cancellationCheckRunning = false;
  const checkCancellation = async () => {
    if (cancellationCheckRunning || cancellation.signal.aborted) return;
    cancellationCheckRunning = true;
    try {
      if (await trainingJobCancelled(taskId)) cancellation.abort();
    } finally {
      cancellationCheckRunning = false;
    }
  };
  const cancellationTimer = setInterval(() => void checkCancellation().catch((error) => console.error('Failed to check training cancellation', error)), 500);
  try {
    await checkCancellation();
    await runPython({ kind: 'training', config: job.config, datasetConfig, outputDir }, async (event) => {
      if (event.event === 'resource') {
        await persistResourceSample(taskId, job.workspace_id, event);
        return;
      }
      if (event.event !== 'progress' || event.stage !== 'train') return;
      const epoch = Number(event.epoch ?? event.step);
      if (!Number.isInteger(epoch) || epoch < 1) return;
      const metrics = metricsFromRunnerEvent(event);
      if (!Object.keys(metrics).length) return;
      const announce = epoch > reportedEpoch;
      await persistTrainingMetric({ jobId: taskId, workspaceId: job.workspace_id, type: job.type, model: job.model, totalEpochs, point: { epoch, metrics }, progress: Number(event.progress ?? 15 + epoch * 70 / totalEpochs), announce });
      reportedEpoch = Math.max(reportedEpoch, epoch);
    }, cancellation.signal);
    await persistYoloMetrics();
  } catch (error) {
    const cancelled = error instanceof RunnerCancelledError || await trainingJobCancelled(taskId).catch(() => false);
    if (!cancelled) throw error;
    await cleanupCancelledTraining(taskId, outputDir);
    return;
  } finally {
    if (metricTimer) clearInterval(metricTimer);
    clearInterval(cancellationTimer);
  }
  const registering = await pool.query("UPDATE training_jobs SET progress = 95, eta = '正在登记产物', updated_at = NOW() WHERE id = $1 AND status = 'running' RETURNING id", [taskId]);
  if (!registering.rowCount) {
    await cleanupCancelledTraining(taskId, outputDir);
    return;
  }
  const artifactFile = await pickTrainingArtifact(outputDir);
  if (!artifactFile) throw new Error(`Training job ${taskId} did not produce an artifact`);
  const metric = ['yolov5', 'yolov8', 'yolov8-seg', 'yolov8-pose'].includes(modelFamily(job.model)) ? await readYoloMetric(outputDir, job.model) : await readTrainingMetric(outputDir);
  const artifact = await registerArtifact({ workspaceId: job.workspace_id, filePath: artifactFile, mimeType: 'application/octet-stream', sourceType: 'training_job', sourceId: taskId, createdBy: job.created_by });
  await appendTrainingEvent(taskId, job.workspace_id, 'info', `训练产物已登记：${path.basename(artifactFile)}`);
  await pool.query(
    "INSERT INTO model_versions(id, workspace_id, name, version, task, source_job, metric_name, metric_value, framework, size, formats, stage, artifact_id, snapshot_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT (id) DO NOTHING",
    [`model-${taskId}`, job.workspace_id, job.name, String(job.config.version ?? taskId), job.type, taskId, metricNameForModel(job.type, job.model), metric === null ? '--' : metric.value.toFixed(4), frameworkFor(job.model), formatBytes(artifact.sizeBytes), JSON.stringify([]), '评估中', artifact.id, job.snapshot_id],
  );
  const completed = await pool.query("UPDATE training_jobs SET status = 'completed', progress = 100, epoch = $3, metric_value = $4, eta = '已完成', artifact_id = $2, updated_at = NOW() WHERE id = $1 AND status = 'running' RETURNING id", [taskId, artifact.id, `${metric?.epochs ?? job.config.epochs} / ${job.config.epochs}`, metric === null ? '--' : metric.value.toFixed(4)]);
  if (completed.rowCount) await appendTrainingEvent(taskId, job.workspace_id, 'info', '训练任务已完成');
  await rm(path.join(artifactRoot, 'runtime', 'training', taskId), { recursive: true, force: true });
}

async function handleConversion(taskId: string) {
  const result = await pool.query('SELECT c.id, c.workspace_id, c.format, c.precision, c.target, c.model_name, c.model_version, c.created_by, c.config, m.task AS model_task, m.framework AS source_framework, a.object_key AS source_object_key, t.model AS source_model, t.config AS source_config FROM conversion_jobs c JOIN model_versions m ON m.workspace_id = c.workspace_id AND m.name = c.model_name AND m.version = c.model_version JOIN artifacts a ON a.id = m.artifact_id LEFT JOIN training_jobs t ON t.id = m.source_job WHERE c.id = $1', [taskId]);
  const task = result.rows[0];
  if (!task) throw new Error(`Conversion job ${taskId} was not found`);
  await pool.query("UPDATE conversion_jobs SET status = 'running', updated_at = NOW() WHERE id = $1", [taskId]);
  const outputDir = artifactDir('conversions', taskId);
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  const sourcePath = path.resolve(artifactRoot, task.source_object_key);
  const resolvedRoot = path.resolve(artifactRoot);
  if (!sourcePath.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error('Source model artifact path is outside the configured artifact root');
  const configuredImageSize = Number(task.source_config?.imageSize);
  const defaultImageSize = Number.isInteger(configuredImageSize) && configuredImageSize >= 128 && configuredImageSize <= 2048 ? configuredImageSize : task.model_task === 'segmentation' ? 512 : task.model_task === 'keypoint' ? 384 : task.model_task === 'sdxl' ? 1024 : 640;
  await pool.query("UPDATE conversion_jobs SET progress = 10, updated_at = NOW() WHERE id = $1", [taskId]);
  await runPython({ kind: 'conversion', config: { ...task.config, format: task.format, precision: task.precision, target: task.target, inputShape: `1,3,${defaultImageSize},${defaultImageSize}`, modelFamily: modelFamily(String(task.source_model ?? task.source_framework ?? '')) }, sourcePath, outputDir });
  const artifactName = task.format === 'ONNX' ? 'converted.onnx' : task.format === 'TensorRT' ? 'converted.engine' : task.format === 'TorchScript' ? 'converted.torchscript.pt' : 'converted-openvino.zip';
  const artifactFile = path.join(outputDir, artifactName);
  const artifactStats = await stat(artifactFile).catch(() => null);
  if (!artifactStats?.isFile() || artifactStats.size === 0) throw new Error(`Conversion job ${taskId} did not produce ${artifactName}`);
  const artifact = await registerArtifact({ workspaceId: task.workspace_id, filePath: artifactFile, mimeType: 'application/octet-stream', sourceType: 'conversion_job', sourceId: taskId, createdBy: task.created_by });
  await pool.query("UPDATE conversion_jobs SET status = 'completed', progress = 100, size = $2, artifact_id = $3, updated_at = NOW() WHERE id = $1", [taskId, formatBytes(artifact.sizeBytes), artifact.id]);
  await pool.query("UPDATE model_versions SET formats = CASE WHEN formats @> $3::jsonb THEN formats ELSE formats || $3::jsonb END WHERE workspace_id = $1 AND name = $2 AND version = $4", [task.workspace_id, task.model_name, JSON.stringify([task.format]), task.model_version]);
}

async function handleExport(taskId: string) {
  const result = await pool.query('SELECT e.id, e.workspace_id, e.dataset_id, e.format, e.scope, e.version_name, e.include_images, e.created_by, d.name, d.version, d.type, d.classes FROM export_tasks e JOIN datasets d ON d.id = e.dataset_id WHERE e.id = $1', [taskId]);
  const task = result.rows[0];
  if (!task) throw new Error(`Export task ${taskId} was not found`);
  await pool.query("UPDATE export_tasks SET status = 'running', progress = 20, updated_at = NOW() WHERE id = $1", [taskId]);
  const outputDir = artifactDir('exports', taskId);
  await mkdir(outputDir, { recursive: true });
  const imageResult = await pool.query(`
    SELECT i.id, i.object_key, i.filename, i.mime_type, i.width, i.height, i.split,
           i.source_asset_id, i.source_frame_number, i.source_timestamp_ms,
           a.annotations, a.captions, a.image_attributes,
           (
             SELECT COUNT(*)::integer
             FROM dataset_images candidate
             JOIN annotation_documents candidate_doc
               ON candidate_doc.dataset_id = candidate.dataset_id
              AND candidate_doc.image_id = candidate.id
             WHERE candidate.dataset_id = i.dataset_id
               AND candidate_doc.review_status = 'approved'
               AND ($2 = 'all' OR candidate.split = $2)
               AND (
                 jsonb_array_length(COALESCE(candidate_doc.annotations, '[]'::jsonb)) > 0
                 OR jsonb_array_length(COALESCE(candidate_doc.captions, '[]'::jsonb)) > 0
                 OR jsonb_array_length(COALESCE(candidate_doc.image_attributes->'tags', '[]'::jsonb)) > 0
               )
           ) AS candidate_image_count
    FROM dataset_images i
    JOIN annotation_documents a
      ON a.dataset_id = i.dataset_id
     AND a.image_id = i.id
     AND a.review_status = 'approved'
    WHERE i.dataset_id = $1
      AND ($2 = 'all' OR i.split = $2)
      AND (
        jsonb_array_length(COALESCE(a.annotations, '[]'::jsonb)) > 0
        OR jsonb_array_length(COALESCE(a.captions, '[]'::jsonb)) > 0
        OR jsonb_array_length(COALESCE(a.image_attributes->'tags', '[]'::jsonb)) > 0
      )
    ORDER BY i.id
  `, [task.dataset_id, task.scope]);
  const exportPath = await createDatasetExport({
    artifactRoot,
    outputDir,
    dataset: { id: task.dataset_id, name: task.name, version: task.version, classes: Array.isArray(task.classes) ? task.classes : [] },
    format: task.format,
    scope: task.scope,
    versionName: task.version_name,
    includeImages: task.include_images,
    includeEmptyApprovedImages: false,
    candidateImageCount: imageResult.rows[0] ? Number(imageResult.rows[0].candidate_image_count) : 0,
    images: imageResult.rows.map((image) => ({ id: image.id, objectKey: image.object_key, filename: image.filename, mimeType: image.mime_type, width: image.width ? Number(image.width) : undefined, height: image.height ? Number(image.height) : undefined, split: image.split, sourceAssetId: image.source_asset_id ?? undefined, sourceFrameNumber: image.source_frame_number ? Number(image.source_frame_number) : undefined, sourceTimestampMs: image.source_timestamp_ms ? Number(image.source_timestamp_ms) : undefined })),
    documents: imageResult.rows.map((image) => ({ imageId: image.id, annotations: image.annotations ?? [], captions: image.captions ?? [], imageAttributes: image.image_attributes ?? undefined })),
  });
  const artifact = await registerArtifact({ workspaceId: task.workspace_id, filePath: exportPath, mimeType: 'application/zip', sourceType: 'export_task', sourceId: taskId, createdBy: task.created_by });
  await pool.query("UPDATE export_tasks SET status = 'completed', progress = 100, artifact_id = $2, updated_at = NOW() WHERE id = $1", [taskId, artifact.id]);
}

async function handleProcessing(taskId: string) {
  const runResult = await pool.query('SELECT * FROM processing_runs WHERE id = $1', [taskId]);
  const run = runResult.rows[0];
  if (!run) throw new Error(`Processing run ${taskId} was not found`);
  if (!run.source_asset_id) {
    const existing = await pool.query(`
      SELECT COUNT(*)::integer AS jobs,
             COUNT(*) FILTER (WHERE d.dataset_id IS NOT NULL)::integer AS annotations
      FROM annotation_segments s
      LEFT JOIN annotation_jobs j ON j.segment_id = s.id
      LEFT JOIN annotation_documents d ON d.dataset_id = s.dataset_id
        AND d.image_id IN (SELECT id FROM dataset_images WHERE dataset_id = s.dataset_id AND (source_asset_id = s.source_asset_id OR s.source_asset_id IS NULL))
      WHERE s.annotation_task_id = (SELECT id FROM annotation_tasks WHERE dataset_id = $1)
    `, [run.dataset_id]);
    if (Number(existing.rows[0]?.annotations ?? 0) > 0) throw new Error('Cannot rebuild processed resources after annotations have started');
    if (Number(existing.rows[0]?.jobs ?? 0) > 0) await pool.query('DELETE FROM annotation_segments WHERE annotation_task_id = (SELECT id FROM annotation_tasks WHERE dataset_id = $1)', [run.dataset_id]);
  }
  if (run.source_asset_id) {
    const annotations = await pool.query('SELECT COUNT(*)::integer AS count FROM annotation_documents d JOIN dataset_images i ON i.dataset_id = d.dataset_id AND i.id = d.image_id WHERE i.source_asset_id = $1', [run.source_asset_id]);
    if (Number(annotations.rows[0]?.count ?? 0) > 0) throw new Error('Cannot replace processed video frames that already have annotations');
    await pool.query('DELETE FROM annotation_segments WHERE source_asset_id = $1', [run.source_asset_id]);
    await pool.query('DELETE FROM dataset_images WHERE source_asset_id = $1', [run.source_asset_id]);
  }
  const assetsResult = await pool.query("SELECT * FROM source_assets WHERE dataset_id = $1 AND upload_status = 'uploaded' AND processing_status <> 'processed' AND ($2::text IS NULL OR id = $2) ORDER BY created_at, id", [run.dataset_id, run.source_asset_id ?? null]);
  const assets = assetsResult.rows;
  if (!assets.length) throw new Error('No processable source assets');
  await pool.query("UPDATE processing_runs SET status = 'running', progress = 1, updated_at = NOW() WHERE id = $1", [taskId]);
  await pool.query("UPDATE annotation_tasks SET status = 'processing' WHERE dataset_id = $1", [run.dataset_id]);
  const failures: string[] = [];
  for (const [assetIndex, asset] of assets.entries()) {
    await pool.query("UPDATE source_assets SET processing_status = 'processing', processing_error = NULL, updated_at = NOW() WHERE id = $1", [asset.id]);
    try {
      const sourcePath = path.resolve(artifactRoot, asset.object_key);
      const root = path.resolve(artifactRoot);
      if (!sourcePath.startsWith(`${root}${path.sep}`)) throw new Error('Source asset path is outside artifact root');
      const outputDir = path.join(artifactRoot, 'datasets', run.dataset_id, 'processed', asset.id);
      await rm(outputDir, { recursive: true, force: true });
      await mkdir(outputDir, { recursive: true });
      let files: ProcessedMediaFile[];
      if (asset.type === 'archive') files = await extractArchiveImages(sourcePath, path.join(outputDir, 'images'));
      else if (asset.type === 'video') files = await extractVideoFrames(sourcePath, path.join(outputDir, 'frames'), {
        type: 'frame_step',
        frameStep: Number(run.frame_step ?? 1),
        startFrame: run.start_frame == null ? undefined : Number(run.start_frame),
        endFrame: run.end_frame == null ? undefined : Number(run.end_frame),
        imageQuality: Number(run.image_quality ?? 95),
      });
      else {
        const existing = await pool.query('SELECT id FROM dataset_images WHERE dataset_id = $1 AND object_key = $2', [run.dataset_id, asset.object_key]);
        const described = await describeImageFile(sourcePath, asset.filename, 1, { mimeType: asset.mime_type });
        if (existing.rowCount) {
          await pool.query('UPDATE dataset_images SET source_asset_id = $2, source_relative_path = $3, extraction_order = 1, processing_run_id = $4, width = $5, height = $6 WHERE id = $1', [existing.rows[0].id, asset.id, asset.filename, taskId, described.width ?? null, described.height ?? null]);
          files = [];
        } else {
          files = [described];
        }
      }
      const fileErrors = 'errors' in files && Array.isArray(files.errors) ? files.errors : [];
      const skippedFiles = 'skipped' in files && Array.isArray(files.skipped) ? files.skipped : [];
      for (const file of files) {
        const duplicate = await pool.query('SELECT id FROM dataset_images WHERE dataset_id = $1 AND content_sha256 = $2 AND source_relative_path = $3 LIMIT 1', [run.dataset_id, file.sha256, file.relativePath]);
        if (duplicate.rowCount) continue;
        const imageId = `image-${randomUUID()}`;
        const objectKey = path.relative(artifactRoot, file.filePath).split(path.sep).join('/');
        const thumbnailPath = path.join(outputDir, 'thumbnails', `${imageId}.jpg`);
        await createThumbnail(file.filePath, thumbnailPath);
        const thumbnailObjectKey = path.relative(artifactRoot, thumbnailPath).split(path.sep).join('/');
        await pool.query('INSERT INTO dataset_images(id, dataset_id, object_key, filename, mime_type, size_bytes, width, height, split, source_asset_id, source_relative_path, source_frame_number, source_timestamp_ms, extraction_order, thumbnail_object_key, processing_run_id, content_sha256) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,\'train\',$9,$10,$11,$12,$13,$14,$15,$16)', [imageId, run.dataset_id, objectKey, file.filename, file.mimeType, file.sizeBytes, file.width ?? null, file.height ?? null, asset.id, file.relativePath, file.frameNumber ?? null, file.timestampMs ?? null, file.order, thumbnailObjectKey, taskId, file.sha256]);
      }
      if (fileErrors.length) {
        const message = fileErrors.join('\n');
        failures.push(`${asset.filename}: ${message}`);
        await pool.query("UPDATE source_assets SET processing_status = 'partial_failed', processing_error = $2, updated_at = NOW() WHERE id = $1", [asset.id, message]);
      } else {
        await pool.query("UPDATE source_assets SET processing_status = 'processed', processing_error = $2, updated_at = NOW() WHERE id = $1", [asset.id, skippedFiles.length ? `跳过重复文件：${skippedFiles.join('; ')}` : null]);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Resource processing failed';
      failures.push(`${asset.filename}: ${message}`);
      await pool.query("UPDATE source_assets SET processing_status = 'failed', processing_error = $2, updated_at = NOW() WHERE id = $1", [asset.id, message]);
    }
    await pool.query('UPDATE processing_runs SET progress = $2, updated_at = NOW() WHERE id = $1', [taskId, Math.round((assetIndex + 1) * 90 / assets.length)]);
  }
  const taskResult = await pool.query('SELECT id FROM annotation_tasks WHERE dataset_id = $1', [run.dataset_id]);
  const annotationTaskId = taskResult.rows[0]?.id;
  if (!annotationTaskId) throw new Error('Annotation task was not found');
  const assetIds = assets.map((asset) => String(asset.id));
  await pool.query(`
    WITH base AS (
      SELECT COALESCE(MAX(i.extraction_order), 0)::integer AS value
      FROM dataset_images i
      JOIN source_assets a ON a.id = i.source_asset_id
      WHERE i.dataset_id = $1 AND a.type <> 'video' AND NOT (i.source_asset_id = ANY($2::text[]))
    ), ordered AS (
      SELECT i.id, base.value + ROW_NUMBER() OVER (ORDER BY a.created_at, a.id, i.source_relative_path, i.id) AS sequence
      FROM dataset_images i
      JOIN source_assets a ON a.id = i.source_asset_id
      CROSS JOIN base
      WHERE i.dataset_id = $1 AND a.type <> 'video' AND i.source_asset_id = ANY($2::text[])
    )
    UPDATE dataset_images i SET extraction_order = ordered.sequence
    FROM ordered WHERE i.id = ordered.id
  `, [run.dataset_id, assetIds]);
  const imageResult = await pool.query(`
    SELECT i.id, i.source_asset_id, i.extraction_order
    FROM dataset_images i
    JOIN source_assets a ON a.id = i.source_asset_id
    WHERE i.dataset_id = $1 AND i.source_asset_id = ANY($2::text[])
    ORDER BY CASE WHEN a.type = 'video' THEN 1 ELSE 0 END, a.created_at, a.id, i.extraction_order, i.id
  `, [run.dataset_id, assetIds]);
  const sourceTypes = Object.fromEntries(assets.map((asset) => [asset.id, asset.type]));
  const segmentSize = Number(run.segment_size ?? 100);
  const drafts = buildSegments(imageResult.rows.map((row) => ({ id: String(row.id), sourceAssetId: String(row.source_asset_id), order: Number(row.extraction_order ?? 0) })), { imageSegmentSize: segmentSize, videoSegmentSize: segmentSize, overlapSize: Number(run.overlap_size ?? 0), sourceTypes });
  const sequenceResult = await pool.query('SELECT COALESCE(MAX(sequence), 0)::integer AS value FROM annotation_segments WHERE annotation_task_id = $1', [annotationTaskId]);
  const sequenceOffset = Number(sequenceResult.rows[0]?.value ?? 0);
  for (const draft of drafts) {
    const segmentId = `segment-${randomUUID()}`;
    const sequence = sequenceOffset + draft.sequence;
    await pool.query('INSERT INTO annotation_segments(id, dataset_id, annotation_task_id, source_asset_id, sequence, start_item_id, end_item_id, item_count) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [segmentId, run.dataset_id, annotationTaskId, draft.sourceAssetId ?? null, sequence, draft.startItemId, draft.endItemId, draft.itemCount]);
    const reviewState = await pool.query<{ total: string; submitted: string; approved: string; rejected: string }>(`SELECT COUNT(*)::text AS total, COUNT(*) FILTER (WHERE d.review_status = 'submitted')::text AS submitted, COUNT(*) FILTER (WHERE d.review_status = 'approved')::text AS approved, COUNT(*) FILTER (WHERE d.review_status = 'rejected')::text AS rejected FROM dataset_images i LEFT JOIN annotation_documents d ON d.dataset_id = i.dataset_id AND d.image_id = i.id WHERE i.dataset_id = $1 AND (($2::text IS NOT NULL AND i.source_asset_id = $2) OR ($2::text IS NULL AND EXISTS (SELECT 1 FROM source_assets segment_asset WHERE segment_asset.id = i.source_asset_id AND segment_asset.type::text <> $$video$$))) AND (i.id IN ($3, $4) OR (i.extraction_order IS NOT NULL AND i.extraction_order BETWEEN (SELECT extraction_order FROM dataset_images WHERE id = $3) AND (SELECT extraction_order FROM dataset_images WHERE id = $4)))`, [run.dataset_id, draft.sourceAssetId ?? null, draft.startItemId, draft.endItemId]);
    const state = reviewState.rows[0];
    const total = Number(state?.total ?? 0);
    const submitted = Number(state?.submitted ?? 0);
    const approved = Number(state?.approved ?? 0);
    const rejected = Number(state?.rejected ?? 0);
    const status = total === draft.itemCount && approved === total ? 'approved' : total === draft.itemCount && submitted === total ? 'submitted' : rejected > 0 ? 'rework' : 'available';
    await pool.query('INSERT INTO annotation_jobs(id, dataset_id, annotation_task_id, segment_id, sequence, status, submitted_at) VALUES ($1,$2,$3,$4,$5,$6,CASE WHEN $6 IN (\'submitted\',\'approved\') THEN NOW() ELSE NULL END) ON CONFLICT DO NOTHING', [`job-${randomUUID()}`, run.dataset_id, annotationTaskId, segmentId, sequence, status]);
  }
  await pool.query('UPDATE datasets SET images = (SELECT COUNT(*) FROM dataset_images WHERE dataset_id = $1), size = (SELECT COALESCE(SUM(size_bytes),0)::text || \' B\' FROM dataset_images WHERE dataset_id = $1), updated_at = NOW() WHERE id = $1', [run.dataset_id]);
  const finalStatus = failures.length === 0 ? 'completed' : failures.length === assets.length ? 'failed' : 'partial_failed';
  await pool.query('UPDATE processing_runs SET status = $2, progress = 100, error_message = $3, updated_at = NOW() WHERE id = $1', [taskId, finalStatus, failures.join('\n') || null]);
  await pool.query("UPDATE annotation_tasks SET status = CASE WHEN $2 = 'failed' THEN 'draft' ELSE 'ready' END WHERE dataset_id = $1", [run.dataset_id, finalStatus]);
}

const worker = new Worker(queueName, async (job) => {
  const kind = job.name as QueueKind;
  const taskId = String((job.data as { taskId: string }).taskId);
  try {
    if (kind === 'training') await handleTraining(taskId);
    else if (kind === 'conversion') await handleConversion(taskId);
    else if (kind === 'export') await handleExport(taskId);
    else await handleProcessing(taskId);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Worker execution failed';
    if (kind === 'training') {
      const failed = await pool.query("UPDATE training_jobs SET status = 'failed', error_message = $2, eta = '执行失败', updated_at = NOW() WHERE id = $1 AND status IN ('queued', 'running') RETURNING workspace_id", [taskId, message]);
      if (failed.rows[0]) await appendTrainingEvent(taskId, failed.rows[0].workspace_id, 'error', message);
      await rm(path.join(artifactRoot, 'runtime', 'training', taskId), { recursive: true, force: true });
    }
    if (kind === 'conversion') await pool.query("UPDATE conversion_jobs SET status = 'failed', error_message = $2, updated_at = NOW() WHERE id = $1", [taskId, message]);
    if (kind === 'export') await pool.query("UPDATE export_tasks SET status = 'failed', error_message = $2, updated_at = NOW() WHERE id = $1", [taskId, message]);
    if (kind === 'processing') await pool.query("UPDATE processing_runs SET status = 'failed', error_message = $2, updated_at = NOW() WHERE id = $1", [taskId, message]);
    throw error;
  }
}, { connection, concurrency: 1 });

const shutdown = async () => {
  await worker.close();
  await connection.quit();
  await pool.end();
};

process.on('SIGTERM', () => { void shutdown().finally(() => process.exit(0)); });
process.on('SIGINT', () => { void shutdown().finally(() => process.exit(0)); });
