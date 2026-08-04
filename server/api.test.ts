import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AuthUser, ConversionTask, Dataset, ModelVersion, TrainingJob } from '../shared/contracts';
import { buildApi } from './api';
import { loadConfig } from './config';
import { MemoryTaskQueue, QueueTaskActiveError, type ExecutionTarget, type QueueTaskKind, type RemoveQueueTaskOptions } from './queue';
import { MemoryRepository } from './repository';

const testPassword = 'Test-only-password-123';
const testUsers: Array<AuthUser & { password: string }> = [
  { id: 'test-admin', workspaceId: 'test-workspace', username: 'admin', displayName: 'Test Admin', role: 'admin', mustChangePassword: false, password: testPassword },
  { id: 'test-engineer', workspaceId: 'test-workspace', username: 'engineer', displayName: 'Test Engineer', role: 'engineer', mustChangePassword: false, password: testPassword },
  { id: 'test-annotator', workspaceId: 'test-workspace', username: 'annotator', displayName: 'Test Annotator', role: 'annotator', mustChangePassword: false, password: testPassword },
];
const testDatasets: Dataset[] = [
  { id: 'test-detection-dataset', name: 'Test Detection Dataset', description: 'API test fixture', version: 'v1', images: 1, annotated: 0, classes: ['defect'], updatedAt: new Date(0).toISOString(), size: '1 KB', status: '可训练' },
  { id: 'test-segmentation-dataset', name: 'Test Segmentation Dataset', description: 'API test fixture', version: 'v1', images: 1, annotated: 1, classes: ['defect'], updatedAt: new Date(0).toISOString(), size: '1 KB', status: '可训练' },
  { id: 'test-keypoint-dataset', name: 'Test Keypoint Dataset', description: 'API test fixture', version: 'v1', images: 1, annotated: 1, classes: ['joint'], updatedAt: new Date(0).toISOString(), size: '1 KB', status: '可训练' },
];
const testModelVersion = '00000000-0000-4000-8000-000000000000';
const testModel: ModelVersion = { id: 'test-model', name: 'Test Model', version: testModelVersion, task: 'detection', sourceJob: testModelVersion, metricName: '待评估', metricValue: '--', framework: 'TorchScript', size: '1 KB', createdAt: new Date(0).toISOString(), formats: [], stage: '评估中', artifactId: 'artifact-test-model' };
const testSdxlVersion = 'train-11111111-1111-4111-8111-111111111111';
const testSdxlModel: ModelVersion = { id: 'test-sdxl-model', name: 'Test SDXL', version: testSdxlVersion, task: 'sdxl', sourceJob: testSdxlVersion, metricName: 'Loss', metricValue: '0.1', framework: 'Diffusers SDXL LoRA / PyTorch', size: '1 KB', createdAt: new Date(0).toISOString(), formats: [], stage: '评估中', artifactId: 'artifact-test-sdxl' };
const failedTrainingJob: TrainingJob = {
  id: 'train-failed-test',
  name: 'Failed YOLO Job',
  type: 'detection',
  model: 'yolov8m',
  dataset: 'Test Detection Dataset v1',
  status: 'failed',
  progress: 12,
  epoch: '12 / 100',
  metricName: 'mAP@50',
  metricValue: '--',
  gpu: '1 × T4 16G',
  createdAt: new Date(0).toISOString(),
  eta: '训练失败',
  errorMessage: 'Worker exited unexpectedly',
  config: { type: 'detection', dataFormat: 'YOLO', name: 'Failed YOLO Job', version: 'v1', datasetId: 'test-detection-dataset', model: 'yolov8m', weightSource: 'pretrained', epochs: 100, batchSize: 8, learningRate: '0.001', imageSize: 640, gpu: '1 × T4 16G', mixedPrecision: true, earlyStopping: true },
};
const repositoryFixtures = { users: testUsers, datasets: testDatasets };

class ArtifactRepository extends MemoryRepository {
  override async getArtifact(id: string) {
    if (id === 'artifact-export-1') return { id, objectKey: 'exports/export-1/dataset.json', filename: 'dataset.json', mimeType: 'application/json', sizeBytes: 2, sha256: 'test-sha256', sourceType: 'export_task', sourceId: 'export-1', createdAt: new Date(0).toISOString() };
    if (id === 'artifact-missing') return { id, objectKey: 'exports/export-1/missing.json', filename: 'missing.json', mimeType: 'application/json', sizeBytes: 0, sha256: 'test-sha256', sourceType: 'export_task', sourceId: 'export-1', createdAt: new Date(0).toISOString() };
    if (id === 'artifact-invalid') return { id, objectKey: '../outside.json', filename: 'outside.json', mimeType: 'application/json', sizeBytes: 0, sha256: 'test-sha256', sourceType: 'export_task', sourceId: 'export-1', createdAt: new Date(0).toISOString() };
    return null;
  }
}

class FinishingTaskQueue extends MemoryTaskQueue {
  readonly removeOptions: Array<RemoveQueueTaskOptions | undefined> = [];

  override async remove(kind: QueueTaskKind, taskId: string, executionTarget: ExecutionTarget = 'gpu', options?: RemoveQueueTaskOptions) {
    this.removeOptions.push(options);
    if (!options?.waitForActiveMs) throw new QueueTaskActiveError();
    await super.remove(kind, taskId, executionTarget, options);
  }
}

describe('product API', () => {
  let app: FastifyInstance;
  let queue: MemoryTaskQueue;

  beforeEach(async () => {
    queue = new MemoryTaskQueue();
    app = await buildApi({ config: loadConfig({ JWT_SECRET: 'test-secret', CORS_ORIGIN: 'http://localhost:5173', FORGE_GPU_ENABLED: 'true' }), repository: new MemoryRepository(repositoryFixtures), queue });
  });

  afterEach(async () => {
    await app.close();
  });

  async function login(username = 'engineer') {
    const response = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username, password: testPassword } });
    expect(response.statusCode).toBe(200);
    return response.json<{ accessToken: string }>().accessToken;
  }

  it('starts the in-memory repository without business records', async () => {
    const emptyRepository = new MemoryRepository();
    expect(await emptyRepository.listDatasets()).toEqual([]);
    expect(await emptyRepository.listTrainingJobs()).toEqual([]);
    expect(await emptyRepository.listModels()).toEqual([]);
    expect(await emptyRepository.listConversions()).toEqual([]);
  });

  it('authenticates a local account and returns the current user', async () => {
    const token = await login('admin');
    const response = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { authorization: `Bearer ${token}` } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ username: 'admin', role: 'admin', mustChangePassword: false });
  });

  it('returns recent audited workspace activities without login noise', async () => {
    const unauthorized = await app.inject({ method: 'GET', url: '/api/v1/activities' });
    expect(unauthorized.statusCode).toBe(401);

    const token = await login();
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/datasets',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Activity Dataset', description: 'activity feed test', version: 'v1', classes: ['defect'] },
    });
    expect(created.statusCode).toBe(201);

    const response = await app.inject({ method: 'GET', url: '/api/v1/activities', headers: { authorization: `Bearer ${token}` } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      items: [{ action: 'dataset.create', entityType: 'dataset', metadata: { name: 'Activity Dataset' }, actor: { id: 'test-engineer', displayName: 'Test Engineer' } }],
    });
    expect(response.json<{ items: Array<{ action: string }> }>().items.some((activity) => activity.action === 'auth.login')).toBe(false);
  });

  it('allows browser preflight for every mutating API method', async () => {
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      const response = await app.inject({
        method: 'OPTIONS',
        url: '/api/v1/datasets/test-detection-dataset/images',
        headers: {
          origin: 'http://localhost:5173',
          'access-control-request-method': method,
          'access-control-request-headers': 'authorization,content-type,x-file-name,x-file-mime-type,x-image-split',
        },
      });
      expect(response.statusCode).toBe(204);
      expect(response.headers['access-control-allow-origin']).toBe('http://localhost:5173');
      expect(response.headers['access-control-allow-methods']).toContain(method);
      expect(response.headers['access-control-allow-headers']).toContain('x-file-name');
    }
  });

  it('routes CPU training and CPU-safe conversions while rejecting TensorRT', async () => {
    await app.close();
    queue = new MemoryTaskQueue();
    const cpuRepository = new MemoryRepository({ ...repositoryFixtures, models: [testModel, testSdxlModel] });
    app = await buildApi({ config: loadConfig({ JWT_SECRET: 'test-secret', CORS_ORIGIN: 'http://localhost:5173', FORGE_GPU_ENABLED: 'false' }), repository: cpuRepository, queue });
    const token = await login();

    const capabilities = await app.inject({ method: 'GET', url: '/api/v1/capabilities' });
    expect(capabilities.statusCode).toBe(200);
    expect(capabilities.json()).toEqual({ gpuEnabled: false, cpuTrainingEnabled: true, cpuOnnxEnabled: true, cpuConversionFormats: ['ONNX', 'TorchScript', 'OpenVINO'] });

    const training = await app.inject({ method: 'POST', url: '/api/v1/training/jobs', headers: { authorization: `Bearer ${token}` }, payload: { type: 'detection', dataFormat: 'YOLO', name: 'CPU-only test job', datasetId: 'test-detection-dataset', model: 'yolov8m', epochs: 100, batchSize: 8, learningRate: '0.001', imageSize: 640, gpu: '1 × T4 16G', mixedPrecision: true, earlyStopping: true } });
    expect(training.statusCode).toBe(202);
    expect(training.json()).toMatchObject({ status: 'queued', gpu: 'CPU', config: { version: 'v1', gpu: 'CPU', mixedPrecision: false, weightSource: 'pretrained' } });
    expect(queue.tasks).toContainEqual({ kind: 'training', taskId: training.json<{ id: string }>().id, executionTarget: 'cpu' });

    const sdxlTraining = await app.inject({ method: 'POST', url: '/api/v1/training/jobs', headers: { authorization: `Bearer ${token}` }, payload: { type: 'sdxl', dataFormat: 'IMAGE_FOLDER', name: 'CPU SDXL rejection', datasetId: 'test-detection-dataset', model: 'sdxl-1.0-lora', weightSource: 'pretrained', epochs: 10, batchSize: 1, learningRate: '0.0001', imageSize: 1024, gpu: 'CPU', mixedPrecision: false, earlyStopping: false } });
    expect(sdxlTraining.statusCode).toBe(503);
    expect(sdxlTraining.json()).toMatchObject({ error: { code: 'SDXL_GPU_REQUIRED' } });
    const pretrainedSegmentation = await app.inject({ method: 'POST', url: '/api/v1/training/jobs', headers: { authorization: `Bearer ${token}` }, payload: { type: 'segmentation', dataFormat: 'COCO_SEGMENTATION', name: 'Pretrained SegFormer', datasetId: 'test-segmentation-dataset', model: 'segformer-b0', weightSource: 'pretrained', epochs: 1, batchSize: 1, learningRate: '0.001', imageSize: 128, gpu: 'CPU', mixedPrecision: false, earlyStopping: false } });
    expect(pretrainedSegmentation.statusCode).toBe(202);
    expect(pretrainedSegmentation.json()).toMatchObject({ config: { weightSource: 'pretrained' } });
    expect(queue.tasks).toContainEqual({ kind: 'training', taskId: pretrainedSegmentation.json<{ id: string }>().id, executionTarget: 'cpu' });

    const pretrainedKeypoint = await app.inject({ method: 'POST', url: '/api/v1/training/jobs', headers: { authorization: `Bearer ${token}` }, payload: { type: 'keypoint', dataFormat: 'COCO_KEYPOINTS', name: 'Pretrained HigherHRNet', datasetId: 'test-keypoint-dataset', model: 'higherhrnet-w32', weightSource: 'pretrained', epochs: 1, batchSize: 1, learningRate: '0.001', imageSize: 128, gpu: 'CPU', mixedPrecision: false, earlyStopping: false } });
    expect(pretrainedKeypoint.statusCode).toBe(202);
    expect(pretrainedKeypoint.json()).toMatchObject({ config: { weightSource: 'pretrained' } });

    const conversion = await app.inject({ method: 'POST', url: '/api/v1/conversions', headers: { authorization: `Bearer ${token}` }, payload: { modelName: 'Test Model', modelVersion: testModelVersion, format: 'ONNX', precision: 'FP32', target: 'Intel CPU' } });
    expect(conversion.statusCode).toBe(202);
    expect(queue.tasks).toContainEqual({ kind: 'conversion', taskId: conversion.json<{ id: string }>().id, executionTarget: 'cpu' });

    const torchScript = await app.inject({ method: 'POST', url: '/api/v1/conversions', headers: { authorization: `Bearer ${token}` }, payload: { modelName: 'Test Model', modelVersion: testModelVersion, format: 'TorchScript', precision: 'FP32', target: 'PyTorch Runtime' } });
    expect(torchScript.statusCode).toBe(202);
    expect(queue.tasks).toContainEqual({ kind: 'conversion', taskId: torchScript.json<{ id: string }>().id, executionTarget: 'cpu' });

    const openVino = await app.inject({ method: 'POST', url: '/api/v1/conversions', headers: { authorization: `Bearer ${token}` }, payload: { modelName: 'Test Model', modelVersion: testModelVersion, format: 'OpenVINO', precision: 'FP32', target: 'Intel CPU' } });
    expect(openVino.statusCode).toBe(202);
    expect(queue.tasks).toContainEqual({ kind: 'conversion', taskId: openVino.json<{ id: string }>().id, executionTarget: 'cpu' });

    const tensorRt = await app.inject({ method: 'POST', url: '/api/v1/conversions', headers: { authorization: `Bearer ${token}` }, payload: { modelName: 'Test Model', modelVersion: testModelVersion, format: 'TensorRT', precision: 'FP16', target: 'NVIDIA T4' } });
    expect(tensorRt.statusCode).toBe(503);
    expect(tensorRt.json()).toMatchObject({ error: { code: 'CPU_CONVERSION_UNAVAILABLE' } });
    const sdxlConversion = await app.inject({ method: 'POST', url: '/api/v1/conversions', headers: { authorization: `Bearer ${token}` }, payload: { modelName: 'Test SDXL', modelVersion: testSdxlVersion, format: 'ONNX', precision: 'FP32', target: 'Intel CPU' } });
    expect(sdxlConversion.statusCode).toBe(503);
    expect(sdxlConversion.json()).toMatchObject({ error: { code: 'SDXL_CONVERSION_GPU_REQUIRED' } });
    expect(await cpuRepository.listTrainingJobs()).toHaveLength(3);
    expect(await cpuRepository.listConversions()).toHaveLength(3);

    const exportTask = await app.inject({ method: 'POST', url: '/api/v1/datasets/test-detection-dataset/exports', headers: { authorization: `Bearer ${token}` }, payload: { format: 'COCO' } });
    expect(exportTask.statusCode).toBe(202);
    expect(queue.tasks).toContainEqual({ kind: 'export', taskId: exportTask.json<{ id: string }>().id, executionTarget: 'cpu' });
  });

  it('requeues a failed training job from its saved config while preserving the failed record', async () => {
    await app.close();
    queue = new MemoryTaskQueue();
    const missingConfigJob: TrainingJob = { ...failedTrainingJob, id: 'train-failed-without-config', name: 'Legacy Failed Job', config: undefined };
    const repository = new MemoryRepository({ ...repositoryFixtures, jobs: [failedTrainingJob, missingConfigJob] });
    app = await buildApi({ config: loadConfig({ JWT_SECRET: 'test-secret', CORS_ORIGIN: 'http://localhost:5173', FORGE_GPU_ENABLED: 'false' }), repository, queue });
    const token = await login();

    const retried = await app.inject({ method: 'POST', url: `/api/v1/training/jobs/${failedTrainingJob.id}/retry`, headers: { authorization: `Bearer ${token}` } });
    expect(retried.statusCode).toBe(202);
    const newJob = retried.json<TrainingJob>();
    expect(newJob.id).not.toBe(failedTrainingJob.id);
    expect(newJob).toMatchObject({ name: 'Failed YOLO Job（重试）', status: 'queued', progress: 0, gpu: 'CPU', config: { gpu: 'CPU', mixedPrecision: false, epochs: 100 } });
    expect(queue.tasks).toContainEqual({ kind: 'training', taskId: newJob.id, executionTarget: 'cpu' });
    expect(await repository.getTrainingJob(failedTrainingJob.id)).toMatchObject({ status: 'failed', errorMessage: 'Worker exited unexpectedly' });
    expect(await repository.listTrainingEvents(newJob.id)).toMatchObject([{ level: 'info', message: `由失败任务 ${failedTrainingJob.id} 重新创建并进入资源队列` }]);

    const queuedRetry = await app.inject({ method: 'POST', url: `/api/v1/training/jobs/${newJob.id}/retry`, headers: { authorization: `Bearer ${token}` } });
    expect(queuedRetry.statusCode).toBe(409);
    expect(queuedRetry.json()).toMatchObject({ error: { code: 'TRAINING_RETRY_NOT_ALLOWED' } });
    const missingConfigRetry = await app.inject({ method: 'POST', url: '/api/v1/training/jobs/train-failed-without-config/retry', headers: { authorization: `Bearer ${token}` } });
    expect(missingConfigRetry.statusCode).toBe(409);
    expect(missingConfigRetry.json()).toMatchObject({ error: { code: 'TRAINING_CONFIG_UNAVAILABLE' } });
    const annotatorToken = await login('annotator');
    const forbidden = await app.inject({ method: 'POST', url: `/api/v1/training/jobs/${failedTrainingJob.id}/retry`, headers: { authorization: `Bearer ${annotatorToken}` } });
    expect(forbidden.statusCode).toBe(403);
  });

  it('deletes terminal training jobs while rejecting active jobs and cleaning queue state', async () => {
    await app.close();
    queue = new MemoryTaskQueue();
    const repository = new MemoryRepository({ ...repositoryFixtures, jobs: [failedTrainingJob] });
    app = await buildApi({ config: loadConfig({ JWT_SECRET: 'test-secret', CORS_ORIGIN: 'http://localhost:5173', FORGE_GPU_ENABLED: 'false' }), repository, queue });
    const token = await login();

    const retried = await app.inject({ method: 'POST', url: `/api/v1/training/jobs/${failedTrainingJob.id}/retry`, headers: { authorization: `Bearer ${token}` } });
    const queuedJob = retried.json<TrainingJob>();
    const activeDelete = await app.inject({ method: 'DELETE', url: `/api/v1/training/jobs/${queuedJob.id}`, headers: { authorization: `Bearer ${token}` } });
    expect(activeDelete.statusCode).toBe(409);
    expect(activeDelete.json()).toMatchObject({ error: { code: 'TRAINING_DELETE_NOT_ALLOWED' } });

    const cancelled = await app.inject({ method: 'POST', url: `/api/v1/training/jobs/${queuedJob.id}/cancel`, headers: { authorization: `Bearer ${token}` } });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toMatchObject({ status: 'cancelled' });
    expect(queue.tasks).not.toContainEqual({ kind: 'training', taskId: queuedJob.id, executionTarget: 'cpu' });
    const deleted = await app.inject({ method: 'DELETE', url: `/api/v1/training/jobs/${queuedJob.id}`, headers: { authorization: `Bearer ${token}` } });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toMatchObject({ removedModels: 0, removedConversions: 0 });
    expect(await repository.getTrainingJob(queuedJob.id)).toBeNull();
    expect(await repository.listTrainingEvents(queuedJob.id)).toEqual([]);
    expect(queue.tasks).not.toContainEqual({ kind: 'training', taskId: queuedJob.id, executionTarget: 'cpu' });

    const annotatorToken = await login('annotator');
    const forbidden = await app.inject({ method: 'DELETE', url: `/api/v1/training/jobs/${failedTrainingJob.id}`, headers: { authorization: `Bearer ${annotatorToken}` } });
    expect(forbidden.statusCode).toBe(403);
    const sourceDeleted = await app.inject({ method: 'DELETE', url: `/api/v1/training/jobs/${failedTrainingJob.id}`, headers: { authorization: `Bearer ${token}` } });
    expect(sourceDeleted.statusCode).toBe(200);
    const missing = await app.inject({ method: 'DELETE', url: `/api/v1/training/jobs/${failedTrainingJob.id}`, headers: { authorization: `Bearer ${token}` } });
    expect(missing.statusCode).toBe(404);
  });

  it('waits for an active cancelled training process before deleting the task', async () => {
    await app.close();
    const runningJob: TrainingJob = { ...failedTrainingJob, id: 'train-running-test', status: 'running', eta: '正在训练', errorMessage: undefined };
    const repository = new MemoryRepository({ ...repositoryFixtures, jobs: [runningJob] });
    const finishingQueue = new FinishingTaskQueue();
    await finishingQueue.enqueue('training', runningJob.id, 'gpu');
    app = await buildApi({ config: loadConfig({ JWT_SECRET: 'test-secret', CORS_ORIGIN: 'http://localhost:5173', FORGE_GPU_ENABLED: 'true' }), repository, queue: finishingQueue });
    const token = await login();

    const cancelled = await app.inject({ method: 'POST', url: `/api/v1/training/jobs/${runningJob.id}/cancel`, headers: { authorization: `Bearer ${token}` } });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toMatchObject({ status: 'cancelled' });
    const deleted = await app.inject({ method: 'DELETE', url: `/api/v1/training/jobs/${runningJob.id}`, headers: { authorization: `Bearer ${token}` } });
    expect(deleted.statusCode).toBe(200);
    expect(finishingQueue.removeOptions).toEqual([undefined, { waitForActiveMs: 10_000 }]);
    expect(await repository.getTrainingJob(runningJob.id)).toBeNull();
  });

  it('deletes a training job together with derived models, conversions, and artifact directories', async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), 'forge-training-delete-'));
    await app.close();
    const derivedModel: ModelVersion = { ...testModel, id: 'model-derived', name: 'Derived Model', version: 'v1', sourceJob: failedTrainingJob.id, artifactId: 'artifact-derived' };
    const conversion: ConversionTask = { id: 'convert-derived', modelName: derivedModel.name, modelVersion: derivedModel.version, format: 'ONNX', precision: 'FP32', target: 'Intel CPU', status: 'completed', progress: 100, size: '1 KB', createdAt: new Date(0).toISOString(), artifactId: 'artifact-converted' };
    const repository = new MemoryRepository({ ...repositoryFixtures, jobs: [failedTrainingJob], models: [derivedModel], conversions: [conversion] });
    app = await buildApi({ config: loadConfig({ JWT_SECRET: 'test-secret', CORS_ORIGIN: 'http://localhost:5173', FORGE_ARTIFACT_ROOT: artifactRoot }), repository, queue });
    await mkdir(join(artifactRoot, 'training', failedTrainingJob.id), { recursive: true });
    await mkdir(join(artifactRoot, 'conversions', conversion.id), { recursive: true });
    await writeFile(join(artifactRoot, 'training', failedTrainingJob.id, 'best.pt'), 'training artifact');
    await writeFile(join(artifactRoot, 'conversions', conversion.id, 'model.onnx'), 'conversion artifact');
    try {
      const token = await login();
      const deleted = await app.inject({ method: 'DELETE', url: `/api/v1/training/jobs/${failedTrainingJob.id}`, headers: { authorization: `Bearer ${token}` } });
      expect(deleted.statusCode).toBe(200);
      expect(deleted.json()).toMatchObject({ removedModels: 1, removedConversions: 1, removedFiles: 2 });
      expect(deleted.json<{ releasedBytes: number }>().releasedBytes).toBeGreaterThan(0);
      expect(await repository.listModels()).toEqual([]);
      expect(await repository.listConversions()).toEqual([]);
      await expect(stat(join(artifactRoot, 'training', failedTrainingJob.id))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(join(artifactRoot, 'conversions', conversion.id))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });

  it('deletes terminal conversion tasks, queue records, and artifact directories', async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), 'forge-conversion-delete-'));
    await app.close();
    queue = new MemoryTaskQueue();
    const completed: ConversionTask = { id: 'convert-completed', modelName: 'Test Model', modelVersion: 'v1', format: 'ONNX', precision: 'FP32', target: 'Intel CPU', status: 'completed', progress: 100, size: '1 KB', createdAt: new Date(0).toISOString(), artifactId: 'artifact-converted' };
    const running: ConversionTask = { ...completed, id: 'convert-running', format: 'OpenVINO', status: 'running', progress: 50, artifactId: undefined };
    const repository = new MemoryRepository({ ...repositoryFixtures, conversions: [completed, running] });
    await queue.enqueue('conversion', completed.id, 'cpu');
    await queue.enqueue('conversion', completed.id, 'gpu');
    app = await buildApi({ config: loadConfig({ JWT_SECRET: 'test-secret', CORS_ORIGIN: 'http://localhost:5173', FORGE_ARTIFACT_ROOT: artifactRoot }), repository, queue });
    await mkdir(join(artifactRoot, 'conversions', completed.id), { recursive: true });
    await writeFile(join(artifactRoot, 'conversions', completed.id, 'model.onnx'), 'conversion artifact');
    try {
      const token = await login();
      const activeDelete = await app.inject({ method: 'DELETE', url: `/api/v1/conversions/${running.id}`, headers: { authorization: `Bearer ${token}` } });
      expect(activeDelete.statusCode).toBe(409);
      expect(activeDelete.json()).toMatchObject({ error: { code: 'CONVERSION_DELETE_NOT_ALLOWED' } });

      const annotatorToken = await login('annotator');
      const forbidden = await app.inject({ method: 'DELETE', url: `/api/v1/conversions/${completed.id}`, headers: { authorization: `Bearer ${annotatorToken}` } });
      expect(forbidden.statusCode).toBe(403);

      const deleted = await app.inject({ method: 'DELETE', url: `/api/v1/conversions/${completed.id}`, headers: { authorization: `Bearer ${token}` } });
      expect(deleted.statusCode).toBe(200);
      expect(deleted.json()).toMatchObject({ removedConversions: 1, removedFiles: 1 });
      expect(deleted.json<{ releasedBytes: number }>().releasedBytes).toBeGreaterThan(0);
      expect(await repository.getConversion(completed.id)).toBeNull();
      expect(queue.tasks).not.toContainEqual({ kind: 'conversion', taskId: completed.id, executionTarget: 'cpu' });
      expect(queue.tasks).not.toContainEqual({ kind: 'conversion', taskId: completed.id, executionTarget: 'gpu' });
      await expect(stat(join(artifactRoot, 'conversions', completed.id))).rejects.toMatchObject({ code: 'ENOENT' });

      const missing = await app.inject({ method: 'DELETE', url: `/api/v1/conversions/${completed.id}`, headers: { authorization: `Bearer ${token}` } });
      expect(missing.statusCode).toBe(404);
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });

  it('persists annotation revisions and rejects stale writes', async () => {
    const token = await login('annotator');
    const first = await app.inject({ method: 'PUT', url: '/api/v1/datasets/test-detection-dataset/images/test-image/annotations', headers: { authorization: `Bearer ${token}` }, payload: { revision: 0, annotations: [{ id: 'rect-001', label: 'defect', color: '#2383f2', geometry: { type: 'rectangle', x: 10, y: 15, width: 20, height: 25 } }], captions: [{ id: 'caption-1', text: 'a metal defect', language: 'en', primary: true, source: 'human' }], imageAttributes: { includeInSdxl: true, tags: ['metal'] } } });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ revision: 1, annotations: [{ id: 'rect-001' }], captions: [{ text: 'a metal defect' }], imageAttributes: { includeInSdxl: true, tags: ['metal'] } });

    const restored = await app.inject({ method: 'GET', url: '/api/v1/datasets/test-detection-dataset/images/test-image/annotations', headers: { authorization: `Bearer ${token}` } });
    expect(restored.statusCode).toBe(200);
    expect(restored.json()).toMatchObject({ revision: 1, annotations: [{ id: 'rect-001' }], captions: [{ text: 'a metal defect' }], imageAttributes: { includeInSdxl: true, tags: ['metal'] } });

    const stale = await app.inject({ method: 'PUT', url: '/api/v1/datasets/test-detection-dataset/images/test-image/annotations', headers: { authorization: `Bearer ${token}` }, payload: { revision: 0, annotations: [] } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: { code: 'ANNOTATION_REVISION_CONFLICT' } });
  });

  it('creates a dataset, persists binary image uploads, and serves image previews', async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), 'forge-dataset-images-'));
    await app.close();
    app = await buildApi({ config: loadConfig({ JWT_SECRET: 'test-secret', CORS_ORIGIN: 'http://localhost:5173', FORGE_ARTIFACT_ROOT: artifactRoot }), repository: new MemoryRepository({ users: testUsers }), queue });
    try {
      const token = await login();
      const created = await app.inject({ method: 'POST', url: '/api/v1/datasets', headers: { authorization: `Bearer ${token}` }, payload: { name: 'Uploaded Images', description: 'binary upload test', version: 'v1', classes: ['defect'] } });
      expect(created.statusCode).toBe(201);
      const dataset = created.json<Dataset>();

      const uploaded = await app.inject({ method: 'PUT', url: `/api/v1/datasets/${dataset.id}/images`, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent('sample.png'), 'x-file-mime-type': 'image/png', 'x-image-split': 'train' }, payload: Buffer.from('sample image bytes') });
      expect(uploaded.statusCode).toBe(201);
      const image = uploaded.json<{ id: string; filename: string; sizeBytes: number }>();
      expect(image).toMatchObject({ filename: 'sample.png', sizeBytes: 18 });

      const listed = await app.inject({ method: 'GET', url: `/api/v1/datasets/${dataset.id}/images`, headers: { authorization: `Bearer ${token}` } });
      expect(listed.statusCode).toBe(200);
      expect(listed.json()).toMatchObject({ items: [{ id: image.id, filename: 'sample.png' }] });

      const preview = await app.inject({ method: 'GET', url: `/api/v1/datasets/${dataset.id}/images/${image.id}/content`, headers: { authorization: `Bearer ${token}` } });
      expect(preview.statusCode).toBe(200);
      expect(preview.headers['content-type']).toContain('image/png');
      expect(preview.body).toBe('sample image bytes');

      const annotation = await app.inject({ method: 'PUT', url: `/api/v1/datasets/${dataset.id}/images/${image.id}/annotations`, headers: { authorization: `Bearer ${token}` }, payload: { revision: 0, annotations: [{ id: 'rect-1', label: 'defect', color: '#2383f2', geometry: { type: 'rectangle', x: 1, y: 1, width: 10, height: 10 } }] } });
      expect(annotation.statusCode).toBe(200);
      const refreshed = await app.inject({ method: 'GET', url: `/api/v1/datasets/${dataset.id}`, headers: { authorization: `Bearer ${token}` } });
      expect(refreshed.json()).toMatchObject({ images: 1, annotated: 1, status: '标注中' });

      const submitted = await app.inject({ method: 'POST', url: `/api/v1/datasets/${dataset.id}/reviews/submit`, headers: { authorization: `Bearer ${token}` } });
      expect(submitted.statusCode).toBe(200);
      expect(submitted.json()).toMatchObject({ datasetStatus: '待审核', submitted: 1, approved: 0, items: [{ imageId: image.id, reviewStatus: 'submitted' }] });

      const locked = await app.inject({ method: 'PUT', url: `/api/v1/datasets/${dataset.id}/images/${image.id}/annotations`, headers: { authorization: `Bearer ${token}` }, payload: { revision: 1, annotations: [] } });
      expect(locked.statusCode).toBe(409);
      expect(locked.json()).toMatchObject({ error: { code: 'ANNOTATION_REVIEW_LOCKED' } });

      const annotatorToken = await login('annotator');
      const forbidden = await app.inject({ method: 'POST', url: `/api/v1/datasets/${dataset.id}/reviews/decision`, headers: { authorization: `Bearer ${annotatorToken}` }, payload: { imageIds: [image.id], decision: 'approve' } });
      expect(forbidden.statusCode).toBe(403);

      const missingReason = await app.inject({ method: 'POST', url: `/api/v1/datasets/${dataset.id}/reviews/decision`, headers: { authorization: `Bearer ${token}` }, payload: { imageIds: [image.id], decision: 'reject' } });
      expect(missingReason.statusCode).toBe(400);
      expect(missingReason.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR', fields: { comment: '驳回时必须填写原因' } } });

      const blockedTraining = await app.inject({ method: 'POST', url: '/api/v1/training/jobs', headers: { authorization: `Bearer ${token}` }, payload: { type: 'detection', dataFormat: 'YOLO', name: 'Review gate test', datasetId: dataset.id, model: 'yolov8n', epochs: 1, batchSize: 1, learningRate: '0.001', imageSize: 128, gpu: 'CPU', mixedPrecision: false, earlyStopping: false } });
      expect(blockedTraining.statusCode).toBe(409);
      expect(blockedTraining.json()).toMatchObject({ error: { code: 'DATASET_REVIEW_REQUIRED' } });
      const blockedExport = await app.inject({ method: 'POST', url: `/api/v1/datasets/${dataset.id}/exports`, headers: { authorization: `Bearer ${token}` }, payload: { format: 'COCO' } });
      expect(blockedExport.statusCode).toBe(409);
      expect(blockedExport.json()).toMatchObject({ error: { code: 'DATASET_REVIEW_REQUIRED' } });

      const approved = await app.inject({ method: 'POST', url: `/api/v1/datasets/${dataset.id}/reviews/decision`, headers: { authorization: `Bearer ${token}` }, payload: { imageIds: [image.id], decision: 'approve' } });
      expect(approved.statusCode).toBe(200);
      expect(approved.json()).toMatchObject({ datasetStatus: '可训练', submitted: 0, approved: 1, items: [{ imageId: image.id, reviewStatus: 'approved' }] });

      const ready = await app.inject({ method: 'GET', url: `/api/v1/datasets/${dataset.id}`, headers: { authorization: `Bearer ${token}` } });
      expect(ready.json()).toMatchObject({ images: 1, annotated: 1, status: '可训练' });

      const deleted = await app.inject({ method: 'DELETE', url: `/api/v1/datasets/${dataset.id}`, headers: { authorization: `Bearer ${token}` } });
      expect(deleted.statusCode).toBe(200);
      expect(deleted.json<{ releasedBytes: number }>().releasedBytes).toBeGreaterThan(0);
      await expect(stat(join(artifactRoot, 'datasets', dataset.id))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });

  it('validates model, dataset and conversion compatibility before queueing', async () => {
    await app.close();
    app = await buildApi({ config: loadConfig({ JWT_SECRET: 'test-secret', CORS_ORIGIN: 'http://localhost:5173', FORGE_GPU_ENABLED: 'true' }), repository: new MemoryRepository({ ...repositoryFixtures, models: [testModel] }), queue });
    const token = await login();
    const training = await app.inject({ method: 'POST', url: '/api/v1/training/jobs', headers: { authorization: `Bearer ${token}` }, payload: { type: 'detection', dataFormat: 'VOC', name: 'Test YOLOv8 Job', version: 'v2.3.0', datasetId: 'test-detection-dataset', model: 'yolov8m', epochs: 100, batchSize: 8, learningRate: '0.001', imageSize: 640, gpu: '1 × T4 16G', mixedPrecision: true, earlyStopping: true } });
    expect(training.statusCode).toBe(202);
    expect(training.json()).toMatchObject({ status: 'queued', model: 'yolov8m', config: { version: 'v2.3.0' } });
    expect(queue.tasks).toContainEqual({ kind: 'training', taskId: training.json<{ id: string }>().id, executionTarget: 'gpu' });
    const events = await app.inject({ method: 'GET', url: `/api/v1/training/jobs/${training.json<{ id: string }>().id}/events`, headers: { authorization: `Bearer ${token}` } });
    expect(events.statusCode).toBe(200);
    expect(events.json()).toMatchObject({ items: [{ level: 'info', message: '训练任务已创建并进入资源队列' }] });
    const observability = await app.inject({ method: 'GET', url: `/api/v1/training/jobs/${training.json<{ id: string }>().id}/observability`, headers: { authorization: `Bearer ${token}` } });
    expect(observability.statusCode).toBe(200);
    expect(observability.json()).toEqual({ metrics: [], resources: [] });

    const incompatibleFormat = await app.inject({ method: 'POST', url: '/api/v1/training/jobs', headers: { authorization: `Bearer ${token}` }, payload: { type: 'detection', dataFormat: 'PNG_MASK', name: 'Invalid format job', datasetId: 'test-detection-dataset', model: 'yolov8m', epochs: 1, batchSize: 1, learningRate: '0.001', imageSize: 128, gpu: '1 × T4 16G', mixedPrecision: true, earlyStopping: true } });
    expect(incompatibleFormat.statusCode).toBe(400);
    expect(incompatibleFormat.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR', fields: { dataFormat: '数据格式与训练任务不兼容' } } });

    const duplicateVersion = await app.inject({ method: 'POST', url: '/api/v1/training/jobs', headers: { authorization: `Bearer ${token}` }, payload: { type: 'detection', dataFormat: 'YOLO', name: testModel.name, version: testModel.version, datasetId: 'test-detection-dataset', model: 'yolov8m', epochs: 1, batchSize: 1, learningRate: '0.001', imageSize: 128, gpu: '1 × T4 16G', mixedPrecision: true, earlyStopping: true } });
    expect(duplicateVersion.statusCode).toBe(409);
    expect(duplicateVersion.json()).toMatchObject({ error: { code: 'MODEL_VERSION_EXISTS' } });

    const invalidConversion = await app.inject({ method: 'POST', url: '/api/v1/conversions', headers: { authorization: `Bearer ${token}` }, payload: { modelName: 'Test Model', modelVersion: 'v1', format: 'TensorRT', precision: 'INT8', target: 'NVIDIA T4' } });
    expect(invalidConversion.statusCode).toBe(400);
    expect(invalidConversion.json()).toMatchObject({ error: { code: 'UNSUPPORTED_CONVERSION_CONFIG' } });
  });

  it('uploads, registers, downloads, and archives a model version', async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), 'forge-model-upload-'));
    await app.close();
    const repository = new MemoryRepository({ users: testUsers });
    app = await buildApi({ config: loadConfig({ JWT_SECRET: 'test-secret', CORS_ORIGIN: 'http://localhost:5173', FORGE_ARTIFACT_ROOT: artifactRoot }), repository, queue });
    try {
      const token = await login();
      const uploaded = await app.inject({ method: 'PUT', url: '/api/v1/models/upload', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent('weights.pt'), 'x-file-mime-type': 'application/octet-stream', 'x-model-name': encodeURIComponent('焊点检测模型'), 'x-model-version': encodeURIComponent('v1'), 'x-model-task': 'detection', 'x-model-framework': encodeURIComponent('PyTorch'), 'x-model-stage': encodeURIComponent('评估中') }, payload: Buffer.from('model bytes') });
      expect(uploaded.statusCode).toBe(201);
      const model = uploaded.json<{ id: string; artifactId: string }>();
      expect(uploaded.json()).toMatchObject({ name: '焊点检测模型', version: 'v1', task: 'detection', stage: '评估中' });

      const archived = await app.inject({ method: 'PATCH', url: `/api/v1/models/${model.id}/stage`, headers: { authorization: `Bearer ${token}` }, payload: { stage: '已归档' } });
      expect(archived.statusCode).toBe(200);
      expect(archived.json()).toMatchObject({ id: model.id, stage: '已归档' });

      const download = await app.inject({ method: 'GET', url: `/api/v1/artifacts/${model.artifactId}/download`, headers: { authorization: `Bearer ${token}` } });
      expect(download.statusCode).toBe(200);
      expect(download.body).toBe('model bytes');

      const conversionResponse = await app.inject({ method: 'POST', url: '/api/v1/conversions', headers: { authorization: `Bearer ${token}` }, payload: { modelName: '焊点检测模型', modelVersion: 'v1', format: 'ONNX', precision: 'FP32', target: 'Intel CPU' } });
      expect(conversionResponse.statusCode).toBe(202);
      const conversion = conversionResponse.json<ConversionTask>();
      await mkdir(join(artifactRoot, 'conversions', conversion.id), { recursive: true });
      await writeFile(join(artifactRoot, 'conversions', conversion.id, 'model.onnx'), 'converted bytes');
      const deleted = await app.inject({ method: 'DELETE', url: `/api/v1/models/${model.id}`, headers: { authorization: `Bearer ${token}` } });
      expect(deleted.statusCode).toBe(200);
      expect(deleted.json()).toMatchObject({ removedModels: 1, removedConversions: 1, removedFiles: 2 });
      expect(await repository.getModel(model.id)).toBeNull();
      expect(await repository.getConversion(conversion.id)).toBeNull();
      await expect(stat(join(artifactRoot, 'models', model.id))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(join(artifactRoot, 'conversions', conversion.id))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });

  it('prevents annotators from creating GPU training jobs', async () => {
    const token = await login('annotator');
    const response = await app.inject({ method: 'POST', url: '/api/v1/training/jobs', headers: { authorization: `Bearer ${token}` }, payload: {} });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
  });

  it('creates and queries an export task with a stable task contract', async () => {
    const token = await login();
    const created = await app.inject({ method: 'POST', url: '/api/v1/datasets/test-detection-dataset/exports', headers: { authorization: `Bearer ${token}` }, payload: { format: 'COCO' } });
    expect(created.statusCode).toBe(202);
    const task = created.json<{ id: string }>();
    expect(queue.tasks).toContainEqual({ kind: 'export', taskId: task.id, executionTarget: 'cpu' });

    const listed = await app.inject({ method: 'GET', url: '/api/v1/datasets/test-detection-dataset/exports', headers: { authorization: `Bearer ${token}` } });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({ items: [{ id: task.id, status: 'queued', progress: 0, format: 'COCO' }] });

    const fetched = await app.inject({ method: 'GET', url: `/api/v1/exports/${task.id}`, headers: { authorization: `Bearer ${token}` } });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json()).toMatchObject({ id: task.id, datasetId: 'test-detection-dataset', format: 'COCO' });
  });

  it('serves registered artifacts only from the configured artifact root', async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), 'forge-artifacts-'));
    await mkdir(join(artifactRoot, 'exports', 'export-1'), { recursive: true });
    await writeFile(join(artifactRoot, 'exports', 'export-1', 'dataset.json'), '{}');
    await app.close();
    app = await buildApi({ config: loadConfig({ JWT_SECRET: 'test-secret', CORS_ORIGIN: 'http://localhost:5173', FORGE_ARTIFACT_ROOT: artifactRoot }), repository: new ArtifactRepository(repositoryFixtures), queue });
    try {
      const token = await login();
      const metadata = await app.inject({ method: 'GET', url: '/api/v1/artifacts/artifact-export-1', headers: { authorization: `Bearer ${token}` } });
      expect(metadata.statusCode).toBe(200);
      expect(metadata.json()).toMatchObject({ filename: 'dataset.json', sourceType: 'export_task' });

      const download = await app.inject({ method: 'GET', url: '/api/v1/artifacts/artifact-export-1/download', headers: { authorization: `Bearer ${token}` } });
      expect(download.statusCode).toBe(200);
      expect(download.headers['content-disposition']).toContain('dataset.json');
      expect(download.body).toBe('{}');

      const missing = await app.inject({ method: 'GET', url: '/api/v1/artifacts/artifact-missing/download', headers: { authorization: `Bearer ${token}` } });
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toMatchObject({ error: { code: 'ARTIFACT_CONTENT_NOT_FOUND' } });

      const invalid = await app.inject({ method: 'GET', url: '/api/v1/artifacts/artifact-invalid/download', headers: { authorization: `Bearer ${token}` } });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json()).toMatchObject({ error: { code: 'INVALID_ARTIFACT_PATH' } });
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });
});
