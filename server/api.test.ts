import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { PNG } from 'pngjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AuthUser, ConversionTask, Dataset, ModelVersion, TrainingJob } from '../shared/contracts';
import { buildApi } from './api';
import { loadConfig } from './config';
import { MemoryTaskQueue, QueueTaskActiveError, type ExecutionTarget, type QueueTaskKind, type RemoveQueueTaskOptions } from './queue';
import { MemoryRepository } from './repository';

const testPassword = 'Test-only-password-123';
const testUsers: Array<AuthUser & { password: string }> = [
  { id: 'test-admin', workspaceId: 'test-workspace', username: 'admin', displayName: 'Test Admin', role: 'admin', mustChangePassword: false, password: testPassword },
  { id: 'test-reviewer', workspaceId: 'test-workspace', username: 'reviewer', displayName: 'Test Reviewer', role: 'reviewer', mustChangePassword: false, password: testPassword },
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

async function createBusinessTask(app: FastifyInstance, token: string) {
  const headers = { authorization: `Bearer ${token}` };
  const catalog = await app.inject({ method: 'GET', url: '/api/v1/task-categories', headers });
  const categoryId = catalog.json<{ categories: Array<{ id: string }> }>().categories[0].id;
  const response = await app.inject({ method: 'POST', url: `/api/v1/task-categories/${categoryId}/task-types`, headers, payload: { name: '测试业务任务' } });
  expect(response.statusCode).toBe(201);
  return response.json<{ id: string }>().id;
}

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

class ExpiredUploadRepository extends MemoryRepository {
  override createUploadSession(input: Parameters<MemoryRepository['createUploadSession']>[0]) {
    return super.createUploadSession({ ...input, expiresAt: new Date(0).toISOString() });
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

  async function login(username = 'reviewer') {
    const response = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username, password: testPassword } });
    expect(response.statusCode).toBe(200);
    return response.json<{ accessToken: string }>().accessToken;
  }

  async function loginWith(targetApp: FastifyInstance, username: string) {
    const response = await targetApp.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username, password: testPassword } });
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

  it('restricts global catalogs to admins and validates immutable codes and mandatory bindings', async () => {
    const token = await login('admin');
    const headers = { authorization: `Bearer ${token}` };
    const taskTypeId = await createBusinessTask(app, token);
    await app.inject({ method: 'PATCH', url: `/api/v1/task-types/${taskTypeId}`, headers, payload: { description: '保持说明', sortOrder: 7, enabled: false } });
    const renamed = await app.inject({ method: 'PATCH', url: `/api/v1/task-types/${taskTypeId}`, headers, payload: { name: '仅改名称' } });
    expect(renamed.json()).toMatchObject({ description: '保持说明', sortOrder: 7, enabled: false });
    await app.inject({ method: 'PATCH', url: `/api/v1/task-types/${taskTypeId}`, headers, payload: { enabled: true } });
    const viewer = { authorization: `Bearer ${await login('reviewer')}` };
    for (const url of ['/api/v1/task-categories', '/api/v1/data-center/tree']) {
      expect((await app.inject({ method: 'GET', url, headers: viewer })).statusCode).toBe(403);
    }
    expect((await app.inject({ method: 'PATCH', url: `/api/v1/task-types/${taskTypeId}`, headers, payload: { code: 'replacement' } })).statusCode).toBe(400);
    const payload = { name: '必须分类', description: '', version: 'v1', classes: [] };
    expect((await app.inject({ method: 'POST', url: '/api/v1/datasets', headers, payload })).statusCode).toBe(400);
    const created = await app.inject({ method: 'POST', url: '/api/v1/datasets', headers, payload: { ...payload, taskTypeId } });
    expect(created.statusCode).toBe(201);
    const datasetId = created.json<{ id: string }>().id;
    const url = `/api/v1/datasets/${datasetId}/task-type`;
    expect((await app.inject({ method: 'PATCH', url, headers, payload: { taskTypeId, expectedTaskTypeId: taskTypeId } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PATCH', url, headers: viewer, payload: { taskTypeId, expectedTaskTypeId: taskTypeId, confirmed: true } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PATCH', url, headers, payload: { taskTypeId, expectedTaskTypeId: null, confirmed: true } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'GET', url: '/api/v1/data-center/tree?from=2026-09-09&to=2026-09-08', headers })).statusCode).toBe(400);
    const tree = await app.inject({ method: 'GET', url: '/api/v1/data-center/tree', headers });
    expect(tree.json()).toMatchObject({ total: 0, items: [] });
  });

  it('authenticates a local account and returns the current user', async () => {
    const token = await login('admin');
    const response = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { authorization: `Bearer ${token}` } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ username: 'admin', role: 'admin', roles: ['admin'], enabled: true, mustChangePassword: false });
  });

  it('enforces one role per user, settings, and immediate disablement', async () => {
    const adminToken = await login('admin');
    const created = await app.inject({ method: 'POST', url: '/api/v1/users', headers: { authorization: `Bearer ${adminToken}` }, payload: { username: 'reviewer-annotator', displayName: 'Reviewer Annotator', password: testPassword, roles: ['reviewer', 'annotator'] } });
    expect(created.statusCode).toBe(400);
    expect(created.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    const validCreated = await app.inject({ method: 'POST', url: '/api/v1/users', headers: { authorization: `Bearer ${adminToken}` }, payload: { username: 'reviewer-only', displayName: 'Reviewer Only', password: testPassword, roles: ['reviewer'] } });
    expect(validCreated.statusCode).toBe(201);
    expect(validCreated.json()).toMatchObject({ username: 'reviewer-only', role: 'reviewer', roles: ['reviewer'], enabled: true, mustChangePassword: true });

    const reviewerToken = await login('reviewer-only');
    const reviewerDataset = await app.inject({ method: 'POST', url: '/api/v1/datasets', headers: { authorization: `Bearer ${reviewerToken}` }, payload: { name: 'Reviewer Dataset', description: '', version: 'v1', classes: [] } });
    expect(reviewerDataset.statusCode).toBe(403);

    const settings = await app.inject({ method: 'PATCH', url: '/api/v1/settings', headers: { authorization: `Bearer ${adminToken}` }, payload: { defaultImageSegmentSize: 200 } });
    expect(settings.statusCode).toBe(200);
    expect(settings.json()).toMatchObject({ defaultImageSegmentSize: 200, defaultVideoSegmentSize: 100 });

    const updated = await app.inject({ method: 'PATCH', url: `/api/v1/users/${validCreated.json<{ id: string }>().id}`, headers: { authorization: `Bearer ${adminToken}` }, payload: { enabled: false } });
    expect(updated.statusCode).toBe(200);
    const denied = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { authorization: `Bearer ${reviewerToken}` } });
    expect(denied.statusCode).toBe(401);
    const loginDisabled = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'reviewer-annotator', password: testPassword } });
    expect(loginDisabled.statusCode).toBe(401);

    const selfDelete = await app.inject({ method: 'DELETE', url: '/api/v1/users/test-admin', headers: { authorization: `Bearer ${adminToken}` } });
    expect(selfDelete.statusCode).toBe(400);
    const deleted = await app.inject({ method: 'DELETE', url: `/api/v1/users/${validCreated.json<{ id: string }>().id}`, headers: { authorization: `Bearer ${adminToken}` } });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toMatchObject({ deleted: true, userId: validCreated.json<{ id: string }>().id });

    const activities = await app.inject({ method: 'GET', url: '/api/v1/activities', headers: { authorization: `Bearer ${adminToken}` } });
    expect(activities.json<{ items: Array<{ action: string }> }>().items.map((item) => item.action)).toEqual(expect.arrayContaining(['user.create', 'user.update', 'user.delete', 'settings.update']));
  });

  it('uploads a resumable source asset without starting processing', async () => {
    const adminToken = await login('admin');
    const dataset = await app.inject({ method: 'POST', url: '/api/v1/datasets', headers: { authorization: `Bearer ${adminToken}` }, payload: { taskTypeId: await createBusinessTask(app, adminToken), name: 'Upload Dataset', description: '', version: 'v1', classes: [] } });
    const task = await app.inject({ method: 'GET', url: `/api/v1/datasets/${dataset.json<{ id: string }>().id}/annotation-task`, headers: { authorization: `Bearer ${adminToken}` } });
    expect(task.statusCode).toBe(200);
    expect(task.json()).toMatchObject({ datasetId: dataset.json<{ id: string }>().id, status: 'draft', name: '默认标注任务' });
    const content = Buffer.from('source asset bytes');
    const create = await app.inject({ method: 'POST', url: `/api/v1/datasets/${dataset.json<{ id: string }>().id}/upload-sessions`, headers: { authorization: `Bearer ${adminToken}` }, payload: { filename: 'inspection.mp4', mimeType: 'video/mp4', sizeBytes: content.length, type: 'video' } });
    expect(create.statusCode).toBe(201);
    const session = create.json<{ id: string; asset: { id: string }; totalParts: number }>();
    expect(session.totalParts).toBe(1);

    const missing = await app.inject({ method: 'POST', url: `/api/v1/upload-sessions/${session.id}/complete`, headers: { authorization: `Bearer ${adminToken}` } });
    expect(missing.statusCode).toBe(409);

    const part = await app.inject({ method: 'PUT', url: `/api/v1/upload-sessions/${session.id}/parts/1`, headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/octet-stream' }, payload: content });
    expect(part.statusCode).toBe(200);
    expect(part.json()).toMatchObject({ partNumber: 1, completedParts: [1] });
    const completed = await app.inject({ method: 'POST', url: `/api/v1/upload-sessions/${session.id}/complete`, headers: { authorization: `Bearer ${adminToken}` }, payload: {} });
    expect(completed.statusCode).toBe(200);
    expect(completed.json()).toMatchObject({ id: session.asset.id, uploadStatus: 'uploaded', processingStatus: 'pending', sizeBytes: content.length });

    const assets = await app.inject({ method: 'GET', url: `/api/v1/datasets/${dataset.json<{ id: string }>().id}/assets`, headers: { authorization: `Bearer ${adminToken}` } });
    expect(assets.json()).toMatchObject({ items: [{ filename: 'inspection.mp4', mimeType: 'video/mp4', uploadStatus: 'uploaded', processingStatus: 'pending' }] });
    const annotatorToken = await login('annotator');
    const forbidden = await app.inject({ method: 'POST', url: `/api/v1/datasets/${dataset.json<{ id: string }>().id}/upload-sessions`, headers: { authorization: `Bearer ${annotatorToken}` }, payload: { filename: 'nope.zip', mimeType: 'application/zip', sizeBytes: 10, type: 'archive' } });
    expect(forbidden.statusCode).toBe(403);
  });

  it('expires upload sessions and removes temporary parts', async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), 'forge-upload-expiry-'));
    await app.close();
    app = await buildApi({ config: loadConfig({ JWT_SECRET: 'test-secret', CORS_ORIGIN: 'http://localhost:5173', FORGE_ARTIFACT_ROOT: artifactRoot }), repository: new ExpiredUploadRepository(repositoryFixtures), queue });
    try {
      const token = await login('admin');
      const dataset = await app.inject({ method: 'POST', url: '/api/v1/datasets', headers: { authorization: `Bearer ${token}` }, payload: { taskTypeId: await createBusinessTask(app, token), name: 'Expired Upload Dataset', description: '', version: 'v1', classes: [] } });
      const create = await app.inject({ method: 'POST', url: `/api/v1/datasets/${dataset.json<{ id: string }>().id}/upload-sessions`, headers: { authorization: `Bearer ${token}` }, payload: { filename: 'expired.zip', mimeType: 'application/zip', sizeBytes: 8, type: 'archive' } });
      const session = create.json<{ id: string }>();
      await stat(join(artifactRoot, 'upload-sessions', session.id, 'parts'));

      const expired = await app.inject({ method: 'GET', url: `/api/v1/upload-sessions/${session.id}`, headers: { authorization: `Bearer ${token}` } });
      expect(expired.statusCode).toBe(200);
      expect(expired.json()).toMatchObject({ status: 'upload_failed' });
      await expect(stat(join(artifactRoot, 'upload-sessions', session.id))).rejects.toMatchObject({ code: 'ENOENT' });

      const retryPart = await app.inject({ method: 'PUT', url: `/api/v1/upload-sessions/${session.id}/parts/1`, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' }, payload: Buffer.from('expired') });
      expect(retryPart.statusCode).toBe(409);
      expect(retryPart.json()).toMatchObject({ error: { code: 'UPLOAD_SESSION_EXPIRED' } });
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });

  it('claims annotation jobs in order and supports audited rework', async () => {
    const repository = new MemoryRepository({ users: testUsers });
    const localApp = await buildApi({ config: loadConfig({ JWT_SECRET: 'test-secret', CORS_ORIGIN: 'http://localhost:5173' }), repository, queue: new MemoryTaskQueue() });
    try {
      const adminToken = await loginWith(localApp, 'admin');
      const annotatorToken = await loginWith(localApp, 'annotator');
      const dataset = await localApp.inject({ method: 'POST', url: '/api/v1/datasets', headers: { authorization: `Bearer ${adminToken}` }, payload: { taskTypeId: await createBusinessTask(localApp, adminToken), name: 'Job Dataset', description: '', version: 'v1', classes: [] } });
      const datasetId = dataset.json<{ id: string }>().id;
      const task = await repository.getAnnotationTask(datasetId);
      await repository.createAnnotationSegments([{ id: 'segment-job-1', datasetId, annotationTaskId: task!.id, sourceAssetId: 'asset-job', sequence: 1, startItemId: 'image-job-1', endItemId: 'image-job-1', itemCount: 1 }, { id: 'segment-job-2', datasetId, annotationTaskId: task!.id, sourceAssetId: 'asset-job', sequence: 2, startItemId: 'image-job-2', endItemId: 'image-job-2', itemCount: 1 }]);
      await repository.updateAnnotationTaskStatus(datasetId, 'annotating');
      const jobs = await localApp.inject({ method: 'GET', url: `/api/v1/datasets/${datasetId}/jobs`, headers: { authorization: `Bearer ${adminToken}` } });
      const firstJob = jobs.json<{ items: Array<{ id: string }> }>().items[0];
      const claim = await localApp.inject({ method: 'POST', url: `/api/v1/datasets/${datasetId}/jobs/claim-next`, headers: { authorization: `Bearer ${annotatorToken}` } });
      expect(claim.statusCode).toBe(200);
      expect(claim.json()).toMatchObject({ id: firstJob.id, status: 'claimed' });
      const duplicate = await localApp.inject({ method: 'POST', url: `/api/v1/annotation-jobs/${firstJob.id}/submit`, headers: { authorization: `Bearer ${adminToken}` } });
      expect(duplicate.statusCode).toBe(403);
      const submitted = await localApp.inject({ method: 'POST', url: `/api/v1/annotation-jobs/${firstJob.id}/submit`, headers: { authorization: `Bearer ${annotatorToken}` } });
      expect(submitted.statusCode).toBe(200);
      const reviewClaim = await localApp.inject({ method: 'POST', url: `/api/v1/datasets/${datasetId}/review-jobs/claim-next`, headers: { authorization: `Bearer ${adminToken}` } });
      expect(reviewClaim.statusCode).toBe(200);
      expect(reviewClaim.json()).toMatchObject({ id: firstJob.id, status: 'reviewing' });
      const invalidBatch = await localApp.inject({ method: 'POST', url: `/api/v1/datasets/${datasetId}/review-jobs/review`, headers: { authorization: `Bearer ${adminToken}` }, payload: { jobIds: [firstJob.id], decision: 'reject' } });
      expect(invalidBatch.statusCode).toBe(400);
      expect(invalidBatch.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
      const approved = await localApp.inject({ method: 'POST', url: `/api/v1/annotation-jobs/${firstJob.id}/review`, headers: { authorization: `Bearer ${adminToken}` }, payload: { decision: 'approve' } });
      expect(approved.statusCode).toBe(200);
      expect(approved.json()).toMatchObject({ status: 'approved' });
      const reopened = await localApp.inject({ method: 'POST', url: `/api/v1/annotation-jobs/${firstJob.id}/reopen`, headers: { authorization: `Bearer ${adminToken}` }, payload: { reason: '需要补充抽检' } });
      expect(reopened.statusCode).toBe(200);
      expect(reopened.json()).toMatchObject({ status: 'rework' });
      const resubmittedRework = await localApp.inject({ method: 'POST', url: `/api/v1/annotation-jobs/${firstJob.id}/submit`, headers: { authorization: `Bearer ${annotatorToken}` } });
      expect(resubmittedRework.statusCode).toBe(200);
      expect(resubmittedRework.json()).toMatchObject({ id: firstJob.id, status: 'submitted', assigneeId: 'test-annotator' });
      const second = await localApp.inject({ method: 'POST', url: `/api/v1/datasets/${datasetId}/jobs/claim-next`, headers: { authorization: `Bearer ${annotatorToken}` } });
      expect(second.statusCode).toBe(200);
      const rework = await localApp.inject({ method: 'PATCH', url: `/api/v1/annotation-jobs/${second.json<{ id: string }>().id}`, headers: { authorization: `Bearer ${adminToken}` }, payload: { status: 'rework', reviewComment: '请补充边界' } });
      expect(rework.statusCode).toBe(200);
      expect(rework.json()).toMatchObject({ status: 'rework', reviewComment: '请补充边界' });
    } finally {
      await localApp.close();
    }
  });

  it('claims the selected review Job instead of replacing it with the next Job', async () => {
    const repository = new MemoryRepository({ users: testUsers });
    const localApp = await buildApi({ config: loadConfig({ JWT_SECRET: 'test-secret', CORS_ORIGIN: 'http://localhost:5173' }), repository, queue: new MemoryTaskQueue() });
    try {
      const adminToken = await loginWith(localApp, 'admin');
      const dataset = await localApp.inject({ method: 'POST', url: '/api/v1/datasets', headers: { authorization: `Bearer ${adminToken}` }, payload: { taskTypeId: await createBusinessTask(localApp, adminToken), name: 'Selected Review Job Dataset', description: '', version: 'v1', classes: [] } });
      const datasetId = dataset.json<{ id: string }>().id;
      const task = await repository.getAnnotationTask(datasetId);
      await repository.createAnnotationSegments([
        { id: 'segment-review-selected-1', datasetId, annotationTaskId: task!.id, sourceAssetId: 'asset-review-selected', sequence: 1, startItemId: 'image-review-selected-1', endItemId: 'image-review-selected-1', itemCount: 1 },
        { id: 'segment-review-selected-2', datasetId, annotationTaskId: task!.id, sourceAssetId: 'asset-review-selected', sequence: 2, startItemId: 'image-review-selected-2', endItemId: 'image-review-selected-2', itemCount: 1 },
      ]);
      await repository.updateAnnotationTaskStatus(datasetId, 'annotating');
      const jobs = await repository.listAnnotationJobs(datasetId);
      for (const job of jobs) {
        const claimed = await repository.claimNextAnnotationJob(datasetId, 'test-annotator');
        expect(claimed?.id).toBe(job.id);
        await repository.submitAnnotationJob(job.id, 'test-annotator');
      }

      const selected = jobs[1];
      const claim = await localApp.inject({ method: 'POST', url: `/api/v1/annotation-jobs/${selected.id}/review-claim`, headers: { authorization: `Bearer ${adminToken}` } });
      expect(claim.statusCode).toBe(200);
      expect(claim.json()).toMatchObject({ id: selected.id, status: 'reviewing' });
      expect((await repository.getAnnotationJob(jobs[0].id))?.status).toBe('submitted');
    } finally {
      await localApp.close();
    }
  });

  it('requires administrators to explicitly open processed annotation tasks', async () => {
    const repository = new MemoryRepository({ users: testUsers });
    const localApp = await buildApi({ config: loadConfig({ JWT_SECRET: 'test-secret', CORS_ORIGIN: 'http://localhost:5173' }), repository, queue: new MemoryTaskQueue() });
    try {
      const adminToken = await loginWith(localApp, 'admin');
      const reviewerToken = await loginWith(localApp, 'reviewer');
      const dataset = await localApp.inject({ method: 'POST', url: '/api/v1/datasets', headers: { authorization: `Bearer ${adminToken}` }, payload: { taskTypeId: await createBusinessTask(localApp, adminToken), name: 'Open Task Dataset', description: '', version: 'v1', classes: [] } });
      const datasetId = dataset.json<{ id: string }>().id;
      const task = await repository.getAnnotationTask(datasetId);
      await repository.createAnnotationSegments([{ id: 'segment-open-1', datasetId, annotationTaskId: task!.id, sequence: 1, startItemId: 'image-open-1', endItemId: 'image-open-1', itemCount: 1 }]);
      await repository.updateAnnotationTaskStatus(datasetId, 'ready');

      const forbidden = await localApp.inject({ method: 'POST', url: `/api/v1/datasets/${datasetId}/annotation-task/open`, headers: { authorization: `Bearer ${reviewerToken}` } });
      expect(forbidden.statusCode).toBe(403);
      const opened = await localApp.inject({ method: 'POST', url: `/api/v1/datasets/${datasetId}/annotation-task/open`, headers: { authorization: `Bearer ${adminToken}` } });
      expect(opened.statusCode).toBe(200);
      expect(opened.json()).toMatchObject({ datasetId, status: 'annotating' });
    } finally {
      await localApp.close();
    }
  });

  it('scopes annotator image and annotation access to the current Job', async () => {
    const repository = new MemoryRepository({ users: testUsers });
    const localApp = await buildApi({ config: loadConfig({ JWT_SECRET: 'test-secret', CORS_ORIGIN: 'http://localhost:5173' }), repository, queue: new MemoryTaskQueue() });
    try {
      const adminToken = await loginWith(localApp, 'admin');
      const annotatorToken = await loginWith(localApp, 'annotator');
      const dataset = await localApp.inject({ method: 'POST', url: '/api/v1/datasets', headers: { authorization: `Bearer ${adminToken}` }, payload: { taskTypeId: await createBusinessTask(localApp, adminToken), name: 'Scoped Dataset', description: '', version: 'v1', classes: [] } });
      const datasetId = dataset.json<{ id: string }>().id;
      const task = await repository.createAnnotationTask(datasetId);
      const first = await repository.createDatasetImage({ datasetId, filename: 'first.jpg', mimeType: 'image/jpeg', sizeBytes: 1, objectKey: 'datasets/scoped/first.jpg', split: 'train' });
      const second = await repository.createDatasetImage({ datasetId, filename: 'second.jpg', mimeType: 'image/jpeg', sizeBytes: 1, objectKey: 'datasets/scoped/second.jpg', split: 'train' });
      await repository.createAnnotationSegments([
        { id: 'segment-scoped-1', datasetId, annotationTaskId: task.id, sequence: 1, startItemId: first.id, endItemId: first.id, itemCount: 1 },
        { id: 'segment-scoped-2', datasetId, annotationTaskId: task.id, sequence: 2, startItemId: second.id, endItemId: second.id, itemCount: 1 },
      ]);
      await repository.updateAnnotationTaskStatus(datasetId, 'annotating');
      const availableJobs = await localApp.inject({ method: 'GET', url: `/api/v1/datasets/${datasetId}/jobs`, headers: { authorization: `Bearer ${annotatorToken}` } });
      expect(availableJobs.statusCode).toBe(200);
      expect(availableJobs.json<{ items: Array<{ status: string; assigneeId?: string }> }>().items.some((job) => job.status === 'available' && !job.assigneeId)).toBe(true);
      await repository.claimNextAnnotationJob(datasetId, 'test-annotator');

      const visible = await localApp.inject({ method: 'GET', url: `/api/v1/datasets/${datasetId}/images`, headers: { authorization: `Bearer ${annotatorToken}` } });
      expect(visible.statusCode).toBe(200);
      expect(visible.json<{ items: Array<{ id: string }> }>().items.map((item) => item.id)).toEqual([first.id]);
      const denied = await localApp.inject({ method: 'GET', url: `/api/v1/datasets/${datasetId}/images/${second.id}/annotations`, headers: { authorization: `Bearer ${annotatorToken}` } });
      expect(denied.statusCode).toBe(403);
      expect(denied.json()).toMatchObject({ error: { code: 'ANNOTATION_JOB_ACCESS_DENIED' } });
    } finally {
      await localApp.close();
    }
  });

  it('records reviewer final-result changes while preserving annotator attribution', async () => {
    const repository = new MemoryRepository({ users: testUsers });
    const localApp = await buildApi({ config: loadConfig({ JWT_SECRET: 'test-secret', CORS_ORIGIN: 'http://localhost:5173' }), repository, queue: new MemoryTaskQueue() });
    try {
      const adminToken = await loginWith(localApp, 'admin');
      const annotatorToken = await loginWith(localApp, 'annotator');
      const reviewerToken = await loginWith(localApp, 'reviewer');
      const dataset = await repository.createDataset({ taskTypeId: await createTestTaskType(repository), name: 'Attribution Dataset', description: '', version: 'v1', classes: ['defect'] });
      const image = await repository.createDatasetImage({ datasetId: dataset.id, filename: 'frame.jpg', mimeType: 'image/jpeg', sizeBytes: 1, objectKey: `datasets/${dataset.id}/frame.jpg`, split: 'train' });
      const task = await repository.getAnnotationTask(dataset.id);
      await repository.createAnnotationSegments([{ id: 'segment-attribution', datasetId: dataset.id, annotationTaskId: task!.id, sequence: 1, startItemId: image.id, endItemId: image.id, itemCount: 1 }]);
      await repository.updateAnnotationTaskStatus(dataset.id, 'annotating');
      const claim = await localApp.inject({ method: 'POST', url: `/api/v1/datasets/${dataset.id}/jobs/claim-next`, headers: { authorization: `Bearer ${annotatorToken}` } });
      const jobId = claim.json<{ id: string }>().id;
      const annotationUrl = `/api/v1/datasets/${dataset.id}/images/${image.id}/annotations`;
      const saved = await localApp.inject({ method: 'PUT', url: annotationUrl, headers: { authorization: `Bearer ${annotatorToken}` }, payload: { revision: 0, annotations: [{ id: 'box-1', label: 'defect', color: '#2383f2', geometry: { type: 'rectangle', x: 10, y: 10, width: 20, height: 20 }, attributes: { severity: 2 }, trackId: 'track-1', keyframe: true, provenance: 'manual', flagged: true }] } });
      expect(saved.statusCode).toBe(200);
      expect(saved.json()).toMatchObject({ annotations: [{ attributes: { severity: 2 }, trackId: 'track-1', keyframe: true, provenance: 'manual', flagged: true }] });
      await localApp.inject({ method: 'POST', url: `/api/v1/annotation-jobs/${jobId}/submit`, headers: { authorization: `Bearer ${annotatorToken}` } });
      await localApp.inject({ method: 'POST', url: `/api/v1/datasets/${dataset.id}/review-jobs/claim-next`, headers: { authorization: `Bearer ${reviewerToken}` } });
      const reviewSave = await localApp.inject({ method: 'PUT', url: `/api/v1/annotation-jobs/${jobId}/images/${image.id}/annotations`, headers: { authorization: `Bearer ${reviewerToken}` }, payload: { revision: 1, annotations: [{ id: 'box-1', label: 'defect', color: '#2383f2', geometry: { type: 'rectangle', x: 15, y: 10, width: 20, height: 20 }, attributes: { severity: 2 }, trackId: 'track-1', keyframe: true, provenance: 'manual', flagged: true }, { id: 'box-2', label: 'defect', color: '#ef4444', geometry: { type: 'rectangle', x: 50, y: 10, width: 10, height: 10 } }] } });
      expect(reviewSave.statusCode).toBe(200);
      expect(reviewSave.json()).toMatchObject({ revision: 2, reviewStatus: 'submitted', annotations: [{ id: 'box-1', attributes: { severity: 2 }, trackId: 'track-1', keyframe: true, provenance: 'manual', flagged: true, createdBy: 'test-annotator', createdByRole: 'annotator' }, { id: 'box-2', createdBy: 'test-reviewer', createdByRole: 'reviewer' }] });

      const activities = await localApp.inject({ method: 'GET', url: '/api/v1/activities', headers: { authorization: `Bearer ${adminToken}` } });
      const reviewActivity = activities.json<{ items: Array<{ action: string; metadata: { changes?: Array<{ changeType: string; changedFields: string[] }>; counts?: Record<string, number> } }> }>().items.find((item) => item.action === 'annotation_job.review_save');
      expect(reviewActivity?.metadata.changes).toEqual(expect.arrayContaining([expect.objectContaining({ objectId: 'box-1', changeType: 'updated', changedFields: ['geometry'] }), expect.objectContaining({ objectId: 'box-2', changeType: 'created' })]));
      expect(reviewActivity?.metadata.counts).toEqual({ added: 1, modified: 1, deleted: 0 });
      const statistics = await localApp.inject({ method: 'GET', url: '/api/v1/annotation-statistics', headers: { authorization: `Bearer ${reviewerToken}` } });
      expect(statistics.json()).toMatchObject({ finalEffectiveObjects: 2, reviewerAddedObjects: 1, reviewerModifiedObjects: 1, reviewerDeletedObjects: 0 });
    } finally {
      await localApp.close();
    }
  });

  it('pauses annotation claiming and supports explicit release and reassignment', async () => {
    await app.close();
    const repository = new MemoryRepository({ users: testUsers });
    const localApp = await buildApi({ config: loadConfig({ JWT_SECRET: 'test-secret', CORS_ORIGIN: 'http://localhost:5173' }), repository, queue: new MemoryTaskQueue() });
    try {
      const adminToken = await loginWith(localApp, 'admin');
      const annotatorToken = await loginWith(localApp, 'annotator');
      const dataset = await localApp.inject({ method: 'POST', url: '/api/v1/datasets', headers: { authorization: `Bearer ${adminToken}` }, payload: { taskTypeId: await createBusinessTask(localApp, adminToken), name: 'Operations Dataset', description: '', version: 'v1', classes: [] } });
      const datasetId = dataset.json<{ id: string }>().id;
      const task = await repository.getAnnotationTask(datasetId);
      await repository.createAnnotationSegments([{ id: 'segment-operations-1', datasetId, annotationTaskId: task!.id, sourceAssetId: 'asset-operations', sequence: 1, startItemId: 'image-operations-1', endItemId: 'image-operations-1', itemCount: 1 }]);
      await repository.updateAnnotationTaskStatus(datasetId, 'annotating');

      const paused = await localApp.inject({ method: 'POST', url: `/api/v1/datasets/${datasetId}/annotation-task/pause`, headers: { authorization: `Bearer ${adminToken}` }, payload: { reason: '维护窗口' } });
      expect(paused.statusCode).toBe(200);
      expect(paused.json()).toMatchObject({ status: 'paused' });
      const blockedClaim = await localApp.inject({ method: 'POST', url: `/api/v1/datasets/${datasetId}/jobs/claim-next`, headers: { authorization: `Bearer ${annotatorToken}` } });
      expect(blockedClaim.statusCode).toBe(409);
      expect(blockedClaim.json()).toMatchObject({ error: { code: 'ANNOTATION_TASK_PAUSED' } });

      const resumed = await localApp.inject({ method: 'POST', url: `/api/v1/datasets/${datasetId}/annotation-task/resume`, headers: { authorization: `Bearer ${adminToken}` } });
      expect(resumed.statusCode).toBe(200);
      expect(resumed.json()).toMatchObject({ status: 'annotating' });
      const claimed = await localApp.inject({ method: 'POST', url: `/api/v1/datasets/${datasetId}/jobs/claim-next`, headers: { authorization: `Bearer ${annotatorToken}` } });
      expect(claimed.statusCode).toBe(200);

      const released = await localApp.inject({ method: 'POST', url: `/api/v1/annotation-jobs/${claimed.json<{ id: string }>().id}/release`, headers: { authorization: `Bearer ${annotatorToken}` }, payload: { reason: '本班次无法继续' } });
      expect(released.statusCode).toBe(403);
      const adminReleased = await localApp.inject({ method: 'POST', url: `/api/v1/annotation-jobs/${claimed.json<{ id: string }>().id}/release`, headers: { authorization: `Bearer ${adminToken}` }, payload: { reason: '本班次无法继续' } });
      expect(adminReleased.statusCode).toBe(200);
      expect(adminReleased.json()).toMatchObject({ status: 'available' });
      expect(adminReleased.json()).not.toHaveProperty('assigneeId');
      const reassigned = await localApp.inject({ method: 'POST', url: `/api/v1/annotation-jobs/${claimed.json<{ id: string }>().id}/reassign`, headers: { authorization: `Bearer ${adminToken}` }, payload: { assigneeId: 'test-annotator', reason: '恢复任务' } });
      expect(reassigned.statusCode).toBe(200);
      expect(reassigned.json()).toMatchObject({ status: 'claimed', assigneeId: 'test-annotator' });
    } finally {
      await localApp.close();
    }
  });

  it('allows administrators to define frozen label attributes', async () => {
    await app.close();
    const repository = new MemoryRepository({ users: testUsers });
    const localApp = await buildApi({ config: loadConfig({ JWT_SECRET: 'test-secret', CORS_ORIGIN: 'http://localhost:5173' }), repository, queue: new MemoryTaskQueue() });
    try {
      const adminToken = await loginWith(localApp, 'admin');
      const annotatorToken = await loginWith(localApp, 'annotator');
      const dataset = await localApp.inject({ method: 'POST', url: '/api/v1/datasets', headers: { authorization: `Bearer ${adminToken}` }, payload: { taskTypeId: await createBusinessTask(localApp, adminToken), name: 'Label Schema Dataset', description: '', version: 'v1', classes: ['defect'] } });
      const datasetId = dataset.json<{ id: string }>().id;
      const labels = [{ name: 'defect', color: '#2383f2', attributes: [{ name: 'severity', type: 'enum', values: ['low', 'high'], required: true }, { name: 'verified', type: 'boolean' }, { name: 'count', type: 'integer' }, { name: 'note', type: 'text' }] }];
      const updated = await localApp.inject({ method: 'PATCH', url: `/api/v1/datasets/${datasetId}/labels`, headers: { authorization: `Bearer ${adminToken}` }, payload: { labels } });
      expect(updated.statusCode).toBe(200);
      expect(updated.json()).toMatchObject({ classes: ['defect'], labels });
      await repository.updateAnnotationTaskStatus(datasetId, 'annotating');
      const frozen = await localApp.inject({ method: 'PATCH', url: `/api/v1/datasets/${datasetId}/labels`, headers: { authorization: `Bearer ${adminToken}` }, payload: { labels: [] } });
      expect(frozen.statusCode).toBe(409);
      expect(frozen.json()).toMatchObject({ error: { code: 'LABEL_SCHEMA_FROZEN' } });
      const forbidden = await localApp.inject({ method: 'PATCH', url: `/api/v1/datasets/${datasetId}/labels`, headers: { authorization: `Bearer ${annotatorToken}` }, payload: { labels: [] } });
      expect(forbidden.statusCode).toBe(403);
    } finally {
      await localApp.close();
    }
  });

  it('queues explicit media processing for administrators only', async () => {
    const adminToken = await login('admin');
    const reviewerToken = await login('reviewer');
    const dataset = await app.inject({ method: 'POST', url: '/api/v1/datasets', headers: { authorization: `Bearer ${adminToken}` }, payload: { taskTypeId: await createBusinessTask(app, adminToken), name: 'Processing Dataset', description: '', version: 'v1', classes: [] } });
    const datasetId = dataset.json<{ id: string }>().id;
    const image = PNG.sync.write(new PNG({ width: 4, height: 2 }));
    const uploaded = await app.inject({ method: 'PUT', url: `/api/v1/datasets/${datasetId}/images`, headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/octet-stream', 'x-file-name': 'queued.png', 'x-file-mime-type': 'image/png' }, payload: image });
    expect(uploaded.statusCode).toBe(201);

    const forbidden = await app.inject({ method: 'POST', url: `/api/v1/datasets/${datasetId}/process`, headers: { authorization: `Bearer ${reviewerToken}` }, payload: { extractionStrategy: 'frame_step', frameStep: 2 } });
    expect(forbidden.statusCode).toBe(403);
    const started = await app.inject({ method: 'POST', url: `/api/v1/datasets/${datasetId}/process`, headers: { authorization: `Bearer ${adminToken}` }, payload: { extractionStrategy: 'frame_step', frameStep: 2, overlapSize: 1, blockSize: 50, useZipBlocks: true, zOrder: true } });
    expect(started.statusCode).toBe(202);
    expect(started.json()).toMatchObject({ datasetId, status: 'queued', progress: 0, extractionStrategy: 'frame_step', frameStep: 2, overlapSize: 1, blockSize: 50, useZipBlocks: true, zOrder: true });
    expect(queue.tasks).toContainEqual({ kind: 'processing', taskId: started.json<{ id: string }>().id, executionTarget: 'cpu' });
    const runs = await app.inject({ method: 'GET', url: `/api/v1/datasets/${datasetId}/processing-runs`, headers: { authorization: `Bearer ${reviewerToken}` } });
    expect(runs.json()).toMatchObject({ items: [{ id: started.json<{ id: string }>().id, status: 'queued' }] });
  });

  it('returns recent audited workspace activities without login noise', async () => {
    const unauthorized = await app.inject({ method: 'GET', url: '/api/v1/activities' });
    expect(unauthorized.statusCode).toBe(401);

    const token = await login('admin');
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/datasets',
      headers: { authorization: `Bearer ${token}` },
      payload: { taskTypeId: await createBusinessTask(app, token), name: 'Activity Dataset', description: 'activity feed test', version: 'v1', classes: ['defect'] },
    });
    expect(created.statusCode).toBe(201);

    const response = await app.inject({ method: 'GET', url: '/api/v1/activities', headers: { authorization: `Bearer ${token}` } });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ items: unknown[] }>().items[0]).toMatchObject({ action: 'dataset.create', entityType: 'dataset', metadata: { name: 'Activity Dataset' }, actor: { id: 'test-admin', displayName: 'Test Admin' } });
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
      const token = await login('admin');
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
      const token = await login('admin');
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
    await app.close();
    const repository = new MemoryRepository({ ...repositoryFixtures, datasets: testDatasets });
    app = await buildApi({ config: loadConfig({ JWT_SECRET: 'test-secret', CORS_ORIGIN: 'http://localhost:5173' }), repository, queue: new MemoryTaskQueue() });
    const token = await login('annotator');
    const task = await repository.createAnnotationTask('test-detection-dataset');
    const image = await repository.createDatasetImage({ datasetId: 'test-detection-dataset', filename: 'test-image.jpg', mimeType: 'image/jpeg', sizeBytes: 1, objectKey: 'datasets/test-detection-dataset/test-image.jpg', split: 'train' });
    await repository.createAnnotationSegments([{ id: 'segment-revision-1', datasetId: 'test-detection-dataset', annotationTaskId: task.id, sequence: 1, startItemId: image.id, endItemId: image.id, itemCount: 1 }]);
    await repository.updateAnnotationTaskStatus('test-detection-dataset', 'annotating');
    await repository.claimNextAnnotationJob('test-detection-dataset', 'test-annotator');
    const imageUrl = `/api/v1/datasets/test-detection-dataset/images/${image.id}/annotations`;
    const first = await app.inject({ method: 'PUT', url: imageUrl, headers: { authorization: `Bearer ${token}` }, payload: { revision: 0, annotations: [{ id: 'rect-001', label: 'defect', color: '#2383f2', geometry: { type: 'rectangle', x: 10, y: 15, width: 20, height: 25 } }], captions: [{ id: 'caption-1', text: 'a metal defect', language: 'en', primary: true, source: 'human' }], imageAttributes: { includeInSdxl: true, tags: ['metal'] } } });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ revision: 1, annotations: [{ id: 'rect-001' }], captions: [{ text: 'a metal defect' }], imageAttributes: { includeInSdxl: true, tags: ['metal'] } });

    const restored = await app.inject({ method: 'GET', url: imageUrl, headers: { authorization: `Bearer ${token}` } });
    expect(restored.statusCode).toBe(200);
    expect(restored.json()).toMatchObject({ revision: 1, annotations: [{ id: 'rect-001' }], captions: [{ text: 'a metal defect' }], imageAttributes: { includeInSdxl: true, tags: ['metal'] } });

    const stale = await app.inject({ method: 'PUT', url: imageUrl, headers: { authorization: `Bearer ${token}` }, payload: { revision: 0, annotations: [] } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: { code: 'ANNOTATION_REVISION_CONFLICT' } });
  });

  it('creates a dataset, persists binary image uploads, and serves image previews', async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), 'forge-dataset-images-'));
    await app.close();
    app = await buildApi({ config: loadConfig({ JWT_SECRET: 'test-secret', CORS_ORIGIN: 'http://localhost:5173', FORGE_ARTIFACT_ROOT: artifactRoot }), repository: new MemoryRepository({ users: testUsers }), queue });
    try {
      const token = await login('admin');
      const created = await app.inject({ method: 'POST', url: '/api/v1/datasets', headers: { authorization: `Bearer ${token}` }, payload: { taskTypeId: await createBusinessTask(app, token), name: 'Uploaded Images', description: 'binary upload test', version: 'v1', classes: ['defect'] } });
      expect(created.statusCode).toBe(201);
      const dataset = created.json<Dataset>();

      const imageBytes = PNG.sync.write(new PNG({ width: 4, height: 2 }));
      const uploaded = await app.inject({ method: 'PUT', url: `/api/v1/datasets/${dataset.id}/images`, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent('sample.png'), 'x-file-mime-type': 'image/png', 'x-image-split': 'train' }, payload: imageBytes });
      expect(uploaded.statusCode).toBe(201);
      const image = uploaded.json<{ id: string; filename: string; sizeBytes: number; width?: number; height?: number }>();
      expect(image).toMatchObject({ filename: 'sample.png', sizeBytes: imageBytes.length, width: 4, height: 2 });

      const listed = await app.inject({ method: 'GET', url: `/api/v1/datasets/${dataset.id}/images`, headers: { authorization: `Bearer ${token}` } });
      expect(listed.statusCode).toBe(200);
      expect(listed.json()).toMatchObject({ items: [{ id: image.id, filename: 'sample.png' }] });

      const preview = await app.inject({ method: 'GET', url: `/api/v1/datasets/${dataset.id}/images/${image.id}/content`, headers: { authorization: `Bearer ${token}` } });
      expect(preview.statusCode).toBe(200);
      expect(preview.headers['content-type']).toContain('image/png');
      expect(preview.body).toBe(imageBytes.toString());

      const annotation = await app.inject({ method: 'PUT', url: `/api/v1/datasets/${dataset.id}/images/${image.id}/annotations`, headers: { authorization: `Bearer ${token}` }, payload: { revision: 0, annotations: [{ id: 'rect-1', label: 'defect', color: '#2383f2', geometry: { type: 'rectangle', x: 1, y: 1, width: 10, height: 10 } }] } });
      expect(annotation.statusCode).toBe(200);
      const refreshed = await app.inject({ method: 'GET', url: `/api/v1/datasets/${dataset.id}`, headers: { authorization: `Bearer ${token}` } });
      expect(refreshed.json()).toMatchObject({ images: 1, annotated: 1, status: '标注中' });

      const annotatorToken = await login('annotator');
      const submitForbidden = await app.inject({ method: 'POST', url: `/api/v1/datasets/${dataset.id}/reviews/submit`, headers: { authorization: `Bearer ${annotatorToken}` } });
      expect(submitForbidden.statusCode).toBe(403);
      const submitted = await app.inject({ method: 'POST', url: `/api/v1/datasets/${dataset.id}/reviews/submit`, headers: { authorization: `Bearer ${token}` } });
      expect(submitted.statusCode).toBe(200);
      expect(submitted.json()).toMatchObject({ datasetStatus: '待审核', submitted: 1, approved: 0, items: [{ imageId: image.id, reviewStatus: 'submitted' }] });

      const locked = await app.inject({ method: 'PUT', url: `/api/v1/datasets/${dataset.id}/images/${image.id}/annotations`, headers: { authorization: `Bearer ${token}` }, payload: { revision: 1, annotations: [] } });
      expect(locked.statusCode).toBe(409);
      expect(locked.json()).toMatchObject({ error: { code: 'ANNOTATION_REVIEW_LOCKED' } });

      const forbidden = await app.inject({ method: 'POST', url: `/api/v1/datasets/${dataset.id}/reviews/decision`, headers: { authorization: `Bearer ${annotatorToken}` }, payload: { imageIds: [image.id], decision: 'approve' } });
      expect(forbidden.statusCode).toBe(403);

      const missingReason = await app.inject({ method: 'POST', url: `/api/v1/datasets/${dataset.id}/reviews/decision`, headers: { authorization: `Bearer ${token}` }, payload: { imageIds: [image.id], decision: 'reject' } });
      expect(missingReason.statusCode).toBe(400);
      expect(missingReason.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR', fields: { comment: '驳回时必须填写原因' } } });

      const blockedTraining = await app.inject({ method: 'POST', url: '/api/v1/training/jobs', headers: { authorization: `Bearer ${token}` }, payload: { type: 'detection', dataFormat: 'YOLO', name: 'Review gate test', datasetId: dataset.id, model: 'yolov8n', epochs: 1, batchSize: 1, learningRate: '0.001', imageSize: 128, gpu: 'CPU', mixedPrecision: false, earlyStopping: false } });
      expect(blockedTraining.statusCode).toBe(409);
      expect(blockedTraining.json()).toMatchObject({ error: { code: 'DATASET_REVIEW_REQUIRED' } });
      const partialExport = await app.inject({ method: 'POST', url: `/api/v1/datasets/${dataset.id}/exports`, headers: { authorization: `Bearer ${token}` }, payload: { format: 'COCO', jobIds: ['ignored-job-selection'] } });
      expect(partialExport.statusCode).toBe(202);
      expect(partialExport.json()).toMatchObject({ scope: 'all', format: 'COCO' });
      expect(partialExport.json()).not.toHaveProperty('jobIds');

      const approved = await app.inject({ method: 'POST', url: `/api/v1/datasets/${dataset.id}/reviews/decision`, headers: { authorization: `Bearer ${token}` }, payload: { imageIds: [image.id], decision: 'approve' } });
      expect(approved.statusCode).toBe(200);
      expect(approved.json()).toMatchObject({ datasetStatus: '可训练', submitted: 0, approved: 1, items: [{ imageId: image.id, reviewStatus: 'approved' }] });

      const ready = await app.inject({ method: 'GET', url: `/api/v1/datasets/${dataset.id}`, headers: { authorization: `Bearer ${token}` } });
      expect(ready.json()).toMatchObject({ images: 1, annotated: 1, status: '可训练' });

      const deletionPreview = await app.inject({ method: 'GET', url: `/api/v1/datasets/${dataset.id}/deletion-preview`, headers: { authorization: `Bearer ${token}` } });
      expect(deletionPreview.statusCode).toBe(200);
      expect(deletionPreview.json()).toMatchObject({ resourceId: dataset.id, counts: { images: 1, annotations: 1 } });
      const unconfirmed = await app.inject({ method: 'DELETE', url: `/api/v1/datasets/${dataset.id}`, headers: { authorization: `Bearer ${token}` } });
      expect(unconfirmed.statusCode).toBe(400);
      expect(unconfirmed.json()).toMatchObject({ error: { code: 'DELETE_CONFIRMATION_REQUIRED' } });
      const deleted = await app.inject({ method: 'DELETE', url: `/api/v1/datasets/${dataset.id}`, headers: { authorization: `Bearer ${token}`, 'x-confirm-resource-id': dataset.id } });
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
    const yoloSegmentation = await app.inject({ method: 'POST', url: '/api/v1/training/jobs', headers: { authorization: `Bearer ${token}` }, payload: { type: 'segmentation', dataFormat: 'YOLO_SEGMENTATION', name: 'Test YOLOv8 Seg Job', version: 'v1', datasetId: 'test-segmentation-dataset', model: 'yolov8n-seg', epochs: 1, batchSize: 1, learningRate: '0.001', imageSize: 128, gpu: '1 × T4 16G', mixedPrecision: true, earlyStopping: false } });
    expect(yoloSegmentation.statusCode).toBe(202);
    expect(yoloSegmentation.json()).toMatchObject({ model: 'yolov8n-seg', config: { dataFormat: 'YOLO_SEGMENTATION' } });
    const yoloPose = await app.inject({ method: 'POST', url: '/api/v1/training/jobs', headers: { authorization: `Bearer ${token}` }, payload: { type: 'keypoint', dataFormat: 'YOLO_KEYPOINTS', name: 'Test YOLOv8 Pose Job', version: 'v1', datasetId: 'test-keypoint-dataset', model: 'yolov8n-pose', epochs: 1, batchSize: 1, learningRate: '0.001', imageSize: 128, gpu: '1 × T4 16G', mixedPrecision: true, earlyStopping: false } });
    expect(yoloPose.statusCode).toBe(202);
    expect(yoloPose.json()).toMatchObject({ model: 'yolov8n-pose', config: { dataFormat: 'YOLO_KEYPOINTS' } });
    const incompatibleYoloSegmentation = await app.inject({ method: 'POST', url: '/api/v1/training/jobs', headers: { authorization: `Bearer ${token}` }, payload: { type: 'segmentation', dataFormat: 'COCO_SEGMENTATION', name: 'Invalid YOLOv8 Seg format', version: 'v1', datasetId: 'test-segmentation-dataset', model: 'yolov8n-seg', epochs: 1, batchSize: 1, learningRate: '0.001', imageSize: 128, gpu: '1 × T4 16G', mixedPrecision: true, earlyStopping: false } });
    expect(incompatibleYoloSegmentation.statusCode).toBe(400);
    expect(incompatibleYoloSegmentation.json()).toMatchObject({ error: { code: 'UNSUPPORTED_MODEL_DATA_FORMAT' } });
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
import { createTestTaskType } from './testCatalogFixtures';
