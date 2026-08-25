import { createReadStream } from 'node:fs';
import { mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import bcrypt from 'bcryptjs';
import { ZodError, type ZodType } from 'zod';
import type { AuthUser, ConversionTask, ResourceDeletionResult, RuntimeCapabilities, TrainingDraft, UserRole } from '../shared/contracts';
import { conversionCatalog, findModelVariant, modelCatalog, modelVariantArchitecture } from '../shared/modelCatalog';
import { annotationReviewDecisionSchema, annotationSaveSchema, conversionRequestSchema, datasetClassesSchema, datasetCreateSchema, exportRequestSchema, loginSchema, modelStageSchema, modelUploadMetadataSchema, trainingDraftSchema } from '../shared/schemas';
import type { ServerConfig } from './config';
import { HttpError, RepositoryConflictError, RepositoryStateError, isHttpError } from './errors';
import { removeManagedArtifactDirectories, type StorageRemovalSummary } from './artifactCleanup';
import { QueueTaskActiveError, type TaskQueue } from './queue';
import type { Repository, StoredUser } from './repository';

interface TokenPayload { userId: string; workspaceId: string; role: UserRole }
interface AuthenticatedRequest extends FastifyRequest { currentUser: StoredUser }

interface ApiDependencies {
  config: ServerConfig;
  repository: Repository;
  queue: TaskQueue;
}

function toAuthUser(user: StoredUser): AuthUser {
  const { passwordHash: _, ...publicUser } = user;
  return publicUser;
}

function parseBody<T>(schema: ZodType<T>, body: unknown): T {
  try {
    return schema.parse(body);
  } catch (error) {
    if (error instanceof ZodError) {
      const fields: Record<string, string> = {};
      for (const issue of error.issues) fields[issue.path.join('.') || 'body'] = issue.message;
      throw new HttpError(400, 'VALIDATION_ERROR', '请求参数不符合要求', fields);
    }
    throw error;
  }
}

function getId(request: FastifyRequest, name: string): string {
  const value = (request.params as Record<string, string | undefined>)[name];
  if (!value) throw new HttpError(400, 'VALIDATION_ERROR', `缺少路径参数 ${name}`);
  return value;
}

function decodeHeader(value: string | string[] | undefined, fieldName: string): string {
  try { return decodeURIComponent(String(value ?? '')); } catch { throw new HttpError(400, 'VALIDATION_ERROR', `${fieldName}编码不合法`); }
}

function deletionResult(storage: StorageRemovalSummary, counts: Partial<Pick<ResourceDeletionResult, 'removedModels' | 'removedConversions' | 'removedExports'>> = {}): ResourceDeletionResult {
  return {
    ...storage,
    removedModels: counts.removedModels ?? 0,
    removedConversions: counts.removedConversions ?? 0,
    removedExports: counts.removedExports ?? 0,
  };
}

export async function buildApi({ config, repository, queue }: ApiDependencies): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, bodyLimit: 512 * 1024 * 1024 });
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));
  await app.register(cors, {
    origin: config.corsOrigin,
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });
  await app.register(jwt, { secret: config.jwtSecret });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof RepositoryConflictError) {
      return reply.status(409).send({ error: { code: 'ANNOTATION_REVISION_CONFLICT', message: error.message, requestId: request.id } });
    }
    if (error instanceof RepositoryStateError) {
      return reply.status(error.code === 'DATASET_NOT_FOUND' ? 404 : 409).send({ error: { code: error.code, message: error.message, requestId: request.id } });
    }
    if (isHttpError(error)) {
      return reply.status(error.statusCode).send({ error: { code: error.code, message: error.message, fields: error.fields, requestId: request.id } });
    }
    request.log.error(error);
    return reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: '服务暂时不可用，请稍后重试', requestId: request.id } });
  });

  const authenticate = async (request: FastifyRequest, _reply: FastifyReply) => {
    try {
      await request.jwtVerify<TokenPayload>();
    } catch {
      throw new HttpError(401, 'UNAUTHORIZED', '登录状态已失效，请重新登录');
    }
    const token = request.user as TokenPayload;
    const user = await repository.findUserById(token.userId);
    if (!user || user.workspaceId !== token.workspaceId || user.role !== token.role) {
      throw new HttpError(401, 'UNAUTHORIZED', '登录状态已失效，请重新登录');
    }
    (request as AuthenticatedRequest).currentUser = user;
  };

  const requireRoles = (...roles: UserRole[]) => async (request: FastifyRequest, reply: FastifyReply) => {
    await authenticate(request, reply);
    if (!roles.includes((request as AuthenticatedRequest).currentUser.role)) {
      throw new HttpError(403, 'FORBIDDEN', '当前账号没有执行此操作的权限');
    }
  };

  const removeConversionQueueTasks = async (tasks: readonly ConversionTask[]) => {
    for (const task of tasks) {
      try {
        await queue.remove('conversion', task.id, 'cpu', { waitForActiveMs: 10_000 });
        await queue.remove('conversion', task.id, 'gpu', { waitForActiveMs: 10_000 });
      } catch (error) {
        if (error instanceof QueueTaskActiveError) throw new HttpError(409, 'RESOURCE_DELETE_PENDING', '关联的模型转换进程正在结束，请稍后重试删除');
        throw error;
      }
    }
  };

  const sendArtifactDownload = async (artifactId: string, reply: FastifyReply) => {
    const artifact = await repository.getArtifact(artifactId);
    if (!artifact) throw new HttpError(404, 'ARTIFACT_NOT_FOUND', '产物不存在');
    const root = resolve(config.artifactRoot);
    const filePath = resolve(root, artifact.objectKey);
    if (!filePath.startsWith(`${root}${sep}`)) throw new HttpError(400, 'INVALID_ARTIFACT_PATH', '产物路径不合法');
    try {
      await stat(filePath);
    } catch {
      throw new HttpError(404, 'ARTIFACT_CONTENT_NOT_FOUND', '产物文件暂不可用');
    }
    return reply
      .type(artifact.mimeType)
      .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(artifact.filename)}`)
      .send(createReadStream(filePath));
  };

  const enqueueTrainingJob = async (draft: TrainingDraft, user: StoredUser, retrySourceId?: string) => {
    if (!config.gpuEnabled && !config.cpuTrainingEnabled) throw new HttpError(503, 'TRAINING_WORKER_UNAVAILABLE', '当前部署未启用可用的训练 Worker');
    const model = findModelVariant(draft.model);
    if (!model || model.task !== draft.type) throw new HttpError(400, 'UNSUPPORTED_MODEL', '所选模型不支持当前训练任务');
    const catalogArchitecture = modelVariantArchitecture(draft.model);
    if (draft.model.endsWith('-rk') && draft.architectureVariant !== 'rk_compatible') throw new HttpError(400, 'RK_VARIANT_REQUIRED', 'RK 友好模型必须选择 RK 友好结构');
    if (draft.architectureVariant === 'rk_compatible' && catalogArchitecture !== 'rk_compatible') throw new HttpError(400, 'RK_VARIANT_UNAVAILABLE', '所选模型尚未完成 RK 友好结构适配');
    if (draft.type === 'sdxl' && !config.gpuEnabled) throw new HttpError(503, 'SDXL_GPU_REQUIRED', 'SDXL 训练需要已启用 CUDA 的 GPU Worker');
    if (draft.type === 'sdxl' && draft.weightSource !== 'pretrained') throw new HttpError(400, 'SDXL_BASE_MODEL_REQUIRED', 'SDXL LoRA 训练必须使用预置的 SDXL Base 模型');
    if (await repository.getModelByNameVersion(draft.name, draft.version)) throw new HttpError(409, 'MODEL_VERSION_EXISTS', '同名模型版本已存在，请修改任务名称或模型版本');
    const dataset = await repository.getDataset(draft.datasetId);
    if (!dataset) throw new HttpError(404, 'DATASET_NOT_FOUND', '数据集不存在');
    if (dataset.status !== '可训练') throw new HttpError(409, 'DATASET_REVIEW_REQUIRED', '数据集全部标注审核通过后才能训练');
    if (config.gpuEnabled && !draft.mixedPrecision && model.minGpuMemoryGb >= 12) throw new HttpError(400, 'GPU_MEMORY_POLICY', 'T4 16GB 上的该模型必须启用混合精度');
    const executionTarget = config.gpuEnabled ? 'gpu' : 'cpu';
    const effectiveDraft = executionTarget === 'cpu' ? { ...draft, gpu: 'CPU', mixedPrecision: false } : draft;
    const job = await repository.createTrainingJob({ draft: effectiveDraft, datasetName: `${dataset.name} ${dataset.version}`, createdBy: user.id, retrySourceId });
    await queue.enqueue('training', job.id, executionTarget);
    return { job, dataset, executionTarget };
  };

  app.get('/api/v1/health', async () => ({ status: 'ok', service: 'forge-api', timestamp: new Date().toISOString() }));
  app.get('/api/v1/ready', async () => ({ status: 'ready' }));
  app.get('/api/v1/capabilities', async (): Promise<RuntimeCapabilities> => ({ gpuEnabled: config.gpuEnabled, cpuTrainingEnabled: config.cpuTrainingEnabled, cpuOnnxEnabled: config.cpuOnnxEnabled, cpuConversionFormats: config.cpuOnnxEnabled ? ['ONNX', 'TorchScript', 'OpenVINO'] : [] }));

  app.post('/api/v1/auth/login', async (request, reply) => {
    const input = parseBody(loginSchema, request.body);
    const user = await repository.findUserByUsername(input.username);
    const valid = user ? await bcrypt.compare(input.password, user.passwordHash) : false;
    if (!valid || !user) throw new HttpError(401, 'INVALID_CREDENTIALS', '账号或密码不正确');
    const accessToken = await reply.jwtSign({ userId: user.id, workspaceId: user.workspaceId, role: user.role }, { expiresIn: '8h' });
    await repository.writeAudit({ actorId: user.id, action: 'auth.login', entityType: 'user', entityId: user.id });
    return { accessToken, user: toAuthUser(user) };
  });

  app.get('/api/v1/auth/me', { preHandler: authenticate }, async (request) => toAuthUser((request as AuthenticatedRequest).currentUser));
  app.get('/api/v1/catalog/models', { preHandler: requireRoles('admin', 'engineer', 'annotator') }, async () => ({ items: modelCatalog }));
  app.get('/api/v1/activities', { preHandler: requireRoles('admin', 'engineer', 'annotator') }, async () => ({ items: await repository.listRecentActivities(5) }));

  app.get('/api/v1/datasets', { preHandler: requireRoles('admin', 'engineer', 'annotator') }, async () => ({ items: await repository.listDatasets() }));
  app.get('/api/v1/datasets/:datasetId', { preHandler: requireRoles('admin', 'engineer', 'annotator') }, async (request) => {
    const dataset = await repository.getDataset(getId(request, 'datasetId'));
    if (!dataset) throw new HttpError(404, 'DATASET_NOT_FOUND', '数据集不存在');
    return dataset;
  });
  app.post('/api/v1/datasets', { preHandler: requireRoles('admin', 'engineer') }, async (request, reply) => {
    const input = parseBody(datasetCreateSchema, request.body);
    const dataset = await repository.createDataset(input);
    await repository.writeAudit({ actorId: (request as AuthenticatedRequest).currentUser.id, action: 'dataset.create', entityType: 'dataset', entityId: dataset.id, metadata: { name: dataset.name } });
    return reply.status(201).send(dataset);
  });
  app.patch('/api/v1/datasets/:datasetId/classes', { preHandler: requireRoles('admin', 'engineer', 'annotator') }, async (request) => {
    const dataset = await repository.updateDatasetClasses(getId(request, 'datasetId'), parseBody(datasetClassesSchema, request.body).classes);
    if (!dataset) throw new HttpError(404, 'DATASET_NOT_FOUND', '数据集不存在');
    await repository.writeAudit({ actorId: (request as AuthenticatedRequest).currentUser.id, action: 'dataset.classes.update', entityType: 'dataset', entityId: dataset.id, metadata: { classes: dataset.classes } });
    return dataset;
  });
  app.delete('/api/v1/datasets/:datasetId', { preHandler: requireRoles('admin', 'engineer') }, async (request, reply) => {
    const datasetId = getId(request, 'datasetId');
    const plan = await repository.getDatasetDeletionPlan(datasetId);
    if (!plan) throw new HttpError(404, 'DATASET_NOT_FOUND', '数据集不存在');
    for (const task of plan.exports) {
      try {
        await queue.remove('export', task.id, 'cpu', { waitForActiveMs: 10_000 });
      } catch (error) {
        if (error instanceof QueueTaskActiveError) throw new HttpError(409, 'RESOURCE_DELETE_PENDING', '关联的数据导出进程正在结束，请稍后重试删除');
        throw error;
      }
    }
    if (!await repository.deleteDataset(datasetId)) throw new HttpError(404, 'DATASET_NOT_FOUND', '数据集不存在');
    const storage = await removeManagedArtifactDirectories(config.artifactRoot, [`datasets/${datasetId}`, ...plan.exports.map((task) => `exports/${task.id}`)]);
    const result = deletionResult(storage, { removedExports: plan.exports.length });
    await repository.writeAudit({ actorId: (request as AuthenticatedRequest).currentUser.id, action: 'dataset.delete', entityType: 'dataset', entityId: datasetId, metadata: { ...result } });
    return reply.send(result);
  });
  app.get('/api/v1/datasets/:datasetId/images', { preHandler: requireRoles('admin', 'engineer', 'annotator') }, async (request) => {
    const datasetId = getId(request, 'datasetId');
    if (!await repository.getDataset(datasetId)) throw new HttpError(404, 'DATASET_NOT_FOUND', '数据集不存在');
    return { items: await repository.listDatasetImages(datasetId) };
  });
  app.put('/api/v1/datasets/:datasetId/images', { preHandler: requireRoles('admin', 'engineer') }, async (request, reply) => {
    const datasetId = getId(request, 'datasetId');
    if (!await repository.getDataset(datasetId)) throw new HttpError(404, 'DATASET_NOT_FOUND', '数据集不存在');
    if (!Buffer.isBuffer(request.body) || request.body.length === 0) throw new HttpError(400, 'INVALID_IMAGE', '请上传非空图像文件');
    if (request.body.length > 50 * 1024 * 1024) throw new HttpError(413, 'IMAGE_TOO_LARGE', '单张图像不能超过 50 MB');
    const mimeType = String(request.headers['x-file-mime-type'] ?? '');
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)) throw new HttpError(400, 'INVALID_IMAGE', '仅支持 JPEG、PNG 或 WebP 图像');
    let decodedFilename = '';
    try { decodedFilename = decodeURIComponent(String(request.headers['x-file-name'] ?? 'image')); } catch { throw new HttpError(400, 'INVALID_IMAGE', '图像文件名编码不合法'); }
    const filename = basename(decodedFilename);
    if (!filename || filename === '.' || filename === '..') throw new HttpError(400, 'INVALID_IMAGE', '图像文件名不合法');
    const splitHeader = String(request.headers['x-image-split'] ?? 'train');
    if (!['train', 'validation', 'test'].includes(splitHeader)) throw new HttpError(400, 'VALIDATION_ERROR', '数据划分不合法');
    const objectKey = `datasets/${datasetId}/${randomUUID()}-${filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const root = resolve(config.artifactRoot);
    const filePath = resolve(root, objectKey);
    if (!filePath.startsWith(`${root}${sep}`)) throw new HttpError(400, 'INVALID_IMAGE', '图像文件路径不合法');
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, request.body);
    try {
      const image = await repository.createDatasetImage({ datasetId, filename, mimeType, sizeBytes: request.body.length, objectKey, split: splitHeader as 'train' | 'validation' | 'test' });
      await repository.writeAudit({ actorId: (request as AuthenticatedRequest).currentUser.id, action: 'dataset.image.upload', entityType: 'dataset_image', entityId: image.id, metadata: { datasetId, filename, sizeBytes: image.sizeBytes } });
      return reply.status(201).send(image);
    } catch (error) {
      await unlink(filePath).catch(() => undefined);
      throw error;
    }
  });
  app.get('/api/v1/datasets/:datasetId/images/:imageId/content', { preHandler: requireRoles('admin', 'engineer', 'annotator') }, async (request, reply) => {
    const image = await repository.getDatasetImage(getId(request, 'datasetId'), getId(request, 'imageId'));
    if (!image) throw new HttpError(404, 'DATASET_IMAGE_NOT_FOUND', '数据集图像不存在');
    const root = resolve(config.artifactRoot);
    const filePath = resolve(root, image.objectKey);
    if (!filePath.startsWith(`${root}${sep}`)) throw new HttpError(400, 'INVALID_IMAGE_PATH', '图像文件路径不合法');
    try { await stat(filePath); } catch { throw new HttpError(404, 'DATASET_IMAGE_CONTENT_NOT_FOUND', '图像文件暂不可用'); }
    return reply.type(image.mimeType).header('content-disposition', `inline; filename*=UTF-8''${encodeURIComponent(image.filename)}`).send(createReadStream(filePath));
  });
  app.get('/api/v1/datasets/:datasetId/images/:imageId/annotations', { preHandler: requireRoles('admin', 'engineer', 'annotator') }, async (request) => {
    const datasetId = getId(request, 'datasetId');
    if (!await repository.getDataset(datasetId)) throw new HttpError(404, 'DATASET_NOT_FOUND', '数据集不存在');
    return repository.getAnnotations(datasetId, getId(request, 'imageId'));
  });
  app.put('/api/v1/datasets/:datasetId/images/:imageId/annotations', { preHandler: requireRoles('admin', 'engineer', 'annotator') }, async (request) => {
    const datasetId = getId(request, 'datasetId');
    if (!await repository.getDataset(datasetId)) throw new HttpError(404, 'DATASET_NOT_FOUND', '数据集不存在');
    const input = parseBody(annotationSaveSchema, request.body);
    const user = (request as AuthenticatedRequest).currentUser;
    const document = await repository.saveAnnotations({ datasetId, imageId: getId(request, 'imageId'), ...input, updatedBy: user.id });
    await repository.writeAudit({ actorId: user.id, action: 'annotation.save', entityType: 'annotation_document', entityId: `${datasetId}:${document.imageId}`, metadata: { revision: document.revision, count: document.annotations.length } });
    return document;
  });
  app.get('/api/v1/datasets/:datasetId/reviews', { preHandler: requireRoles('admin', 'engineer', 'annotator') }, async (request) => {
    const datasetId = getId(request, 'datasetId');
    if (!await repository.getDataset(datasetId)) throw new HttpError(404, 'DATASET_NOT_FOUND', '数据集不存在');
    return repository.getAnnotationReviewSummary(datasetId);
  });
  app.post('/api/v1/datasets/:datasetId/reviews/submit', { preHandler: requireRoles('admin', 'engineer', 'annotator') }, async (request) => {
    const datasetId = getId(request, 'datasetId');
    if (!await repository.getDataset(datasetId)) throw new HttpError(404, 'DATASET_NOT_FOUND', '数据集不存在');
    const user = (request as AuthenticatedRequest).currentUser;
    const summary = await repository.submitAnnotationReview(datasetId, user.id);
    await repository.writeAudit({ actorId: user.id, action: 'annotation.review.submit', entityType: 'dataset', entityId: datasetId, metadata: { submitted: summary.submitted, approved: summary.approved } });
    return summary;
  });
  app.post('/api/v1/datasets/:datasetId/reviews/decision', { preHandler: requireRoles('admin', 'engineer') }, async (request) => {
    const datasetId = getId(request, 'datasetId');
    if (!await repository.getDataset(datasetId)) throw new HttpError(404, 'DATASET_NOT_FOUND', '数据集不存在');
    const input = parseBody(annotationReviewDecisionSchema, request.body);
    const user = (request as AuthenticatedRequest).currentUser;
    const summary = await repository.decideAnnotationReview(datasetId, { ...input, reviewedBy: user.id });
    await repository.writeAudit({ actorId: user.id, action: `annotation.review.${input.decision}`, entityType: 'dataset', entityId: datasetId, metadata: { imageIds: input.imageIds, comment: input.comment } });
    return summary;
  });
  app.post('/api/v1/datasets/:datasetId/exports', { preHandler: requireRoles('admin', 'engineer') }, async (request, reply) => {
    const datasetId = getId(request, 'datasetId');
    const dataset = await repository.getDataset(datasetId);
    if (!dataset) throw new HttpError(404, 'DATASET_NOT_FOUND', '数据集不存在');
    if (dataset.status !== '可训练') throw new HttpError(409, 'DATASET_REVIEW_REQUIRED', '数据集全部标注审核通过后才能导出');
    const input = parseBody(exportRequestSchema, request.body);
    const user = (request as AuthenticatedRequest).currentUser;
    const task = await repository.createExport({ datasetId, format: input.format, scope: input.scope, versionName: input.versionName, includeImages: input.includeImages, createdBy: user.id });
    await queue.enqueue('export', task.id, 'cpu');
    await repository.writeAudit({ actorId: user.id, action: 'dataset.export.create', entityType: 'export_task', entityId: task.id, metadata: { datasetId, format: task.format } });
    return reply.status(202).send(task);
  });
  app.get('/api/v1/datasets/:datasetId/exports', { preHandler: requireRoles('admin', 'engineer', 'annotator') }, async (request) => {
    const datasetId = getId(request, 'datasetId');
    if (!await repository.getDataset(datasetId)) throw new HttpError(404, 'DATASET_NOT_FOUND', '数据集不存在');
    return { items: await repository.listExports(datasetId) };
  });
  app.get('/api/v1/exports/:exportId', { preHandler: requireRoles('admin', 'engineer', 'annotator') }, async (request) => {
    const task = await repository.getExport(getId(request, 'exportId'));
    if (!task) throw new HttpError(404, 'EXPORT_NOT_FOUND', '导出任务不存在');
    return task;
  });
  app.get('/api/v1/artifacts/:artifactId/download', { preHandler: requireRoles('admin', 'engineer', 'annotator') }, async (request, reply) => sendArtifactDownload(getId(request, 'artifactId'), reply));
  app.get('/api/v1/artifacts/:artifactId', { preHandler: requireRoles('admin', 'engineer', 'annotator') }, async (request) => {
    const artifact = await repository.getArtifact(getId(request, 'artifactId'));
    if (!artifact) throw new HttpError(404, 'ARTIFACT_NOT_FOUND', '产物不存在');
    return artifact;
  });

  app.get('/api/v1/training/jobs', { preHandler: requireRoles('admin', 'engineer', 'annotator') }, async () => ({ items: await repository.listTrainingJobs() }));
  app.get('/api/v1/training/jobs/:jobId', { preHandler: requireRoles('admin', 'engineer', 'annotator') }, async (request) => {
    const job = await repository.getTrainingJob(getId(request, 'jobId'));
    if (!job) throw new HttpError(404, 'TRAINING_JOB_NOT_FOUND', '训练任务不存在');
    return job;
  });
  app.get('/api/v1/training/jobs/:jobId/events', { preHandler: requireRoles('admin', 'engineer', 'annotator') }, async (request) => {
    const jobId = getId(request, 'jobId');
    if (!await repository.getTrainingJob(jobId)) throw new HttpError(404, 'TRAINING_JOB_NOT_FOUND', '训练任务不存在');
    return { items: await repository.listTrainingEvents(jobId) };
  });
  app.get('/api/v1/training/jobs/:jobId/observability', { preHandler: requireRoles('admin', 'engineer', 'annotator') }, async (request) => {
    const jobId = getId(request, 'jobId');
    if (!await repository.getTrainingJob(jobId)) throw new HttpError(404, 'TRAINING_JOB_NOT_FOUND', '训练任务不存在');
    return repository.getTrainingObservability(jobId);
  });
  app.post('/api/v1/training/jobs', { preHandler: requireRoles('admin', 'engineer') }, async (request, reply) => {
    const draft = parseBody(trainingDraftSchema, request.body) as TrainingDraft;
    const user = (request as AuthenticatedRequest).currentUser;
    const { job, dataset, executionTarget } = await enqueueTrainingJob(draft, user);
    await repository.writeAudit({ actorId: user.id, action: 'training.create', entityType: 'training_job', entityId: job.id, metadata: { model: job.model, version: draft.version, datasetId: dataset.id, executionTarget } });
    return reply.status(202).send(job);
  });
  app.post('/api/v1/training/jobs/:jobId/retry', { preHandler: requireRoles('admin', 'engineer') }, async (request, reply) => {
    const sourceJobId = getId(request, 'jobId');
    const sourceJob = await repository.getTrainingJob(sourceJobId);
    if (!sourceJob) throw new HttpError(404, 'TRAINING_JOB_NOT_FOUND', '训练任务不存在');
    if (sourceJob.status !== 'failed') throw new HttpError(409, 'TRAINING_RETRY_NOT_ALLOWED', '只有失败的训练任务可以重新训练');
    const parsedConfig = trainingDraftSchema.safeParse(sourceJob.config);
    if (!parsedConfig.success) throw new HttpError(409, 'TRAINING_CONFIG_UNAVAILABLE', '该历史任务没有保存完整训练配置，请新建训练任务');
    const retryName = sourceJob.name.endsWith('（重试）') ? sourceJob.name : `${sourceJob.name.slice(0, 116)}（重试）`;
    const user = (request as AuthenticatedRequest).currentUser;
    const { job, dataset, executionTarget } = await enqueueTrainingJob({ ...parsedConfig.data, name: retryName } as TrainingDraft, user, sourceJobId);
    await repository.writeAudit({ actorId: user.id, action: 'training.retry', entityType: 'training_job', entityId: job.id, metadata: { sourceJobId, model: job.model, datasetId: dataset.id, executionTarget } });
    return reply.status(202).send(job);
  });
  app.post('/api/v1/training/jobs/:jobId/cancel', { preHandler: requireRoles('admin', 'engineer') }, async (request) => {
    const job = await repository.cancelTrainingJob(getId(request, 'jobId'));
    if (!job) throw new HttpError(404, 'TRAINING_JOB_NOT_FOUND', '训练任务不存在');
    try {
      await queue.remove('training', job.id, job.gpu === 'CPU' ? 'cpu' : 'gpu');
    } catch (error) {
      if (!(error instanceof QueueTaskActiveError)) throw error;
    }
    await repository.writeAudit({ actorId: (request as AuthenticatedRequest).currentUser.id, action: 'training.cancel', entityType: 'training_job', entityId: job.id });
    return job;
  });
  app.delete('/api/v1/training/jobs/:jobId', { preHandler: requireRoles('admin', 'engineer') }, async (request, reply) => {
    const jobId = getId(request, 'jobId');
    const plan = await repository.getTrainingDeletionPlan(jobId);
    if (!plan) throw new HttpError(404, 'TRAINING_JOB_NOT_FOUND', '训练任务不存在');
    const { job } = plan;
    if (job.status === 'queued' || job.status === 'running') throw new HttpError(409, 'TRAINING_DELETE_NOT_ALLOWED', '排队或运行中的任务不能删除，请先停止任务');
    try {
      await queue.remove('training', job.id, job.gpu === 'CPU' ? 'cpu' : 'gpu', { waitForActiveMs: 10_000 });
    } catch (error) {
      if (error instanceof QueueTaskActiveError) throw new HttpError(409, 'TRAINING_DELETE_PENDING', '训练进程正在结束，请稍后重试删除');
      throw error;
    }
    await removeConversionQueueTasks(plan.conversions);
    if (!await repository.deleteTrainingJob(job.id)) throw new HttpError(404, 'TRAINING_JOB_NOT_FOUND', '训练任务不存在');
    const storage = await removeManagedArtifactDirectories(config.artifactRoot, [
      `training/${job.id}`,
      `runtime/training/${job.id}`,
      ...plan.models.map((model) => `models/${model.id}`),
      ...plan.conversions.map((task) => `conversions/${task.id}`),
    ]);
    const result = deletionResult(storage, { removedModels: plan.models.length, removedConversions: plan.conversions.length });
    const user = (request as AuthenticatedRequest).currentUser;
    await repository.writeAudit({ actorId: user.id, action: 'training.delete', entityType: 'training_job', entityId: job.id, metadata: { name: job.name, status: job.status, ...result } });
    return reply.send(result);
  });

  app.get('/api/v1/models', { preHandler: requireRoles('admin', 'engineer', 'annotator') }, async () => ({ items: await repository.listModels() }));
  app.get('/api/v1/models/:modelId', { preHandler: requireRoles('admin', 'engineer', 'annotator') }, async (request) => {
    const model = await repository.getModel(getId(request, 'modelId'));
    if (!model) throw new HttpError(404, 'MODEL_NOT_FOUND', '模型版本不存在');
    return model;
  });
  app.put('/api/v1/models/upload', { preHandler: requireRoles('admin', 'engineer') }, async (request, reply) => {
    if (!Buffer.isBuffer(request.body) || request.body.length === 0) throw new HttpError(400, 'INVALID_MODEL_FILE', '请上传非空模型文件');
    let filename = '';
    filename = basename(decodeHeader(request.headers['x-file-name'], '模型文件名'));
    const metadata = parseBody(modelUploadMetadataSchema, {
      name: decodeHeader(request.headers['x-model-name'], '模型名称'),
      version: decodeHeader(request.headers['x-model-version'], '模型版本'),
      task: decodeHeader(request.headers['x-model-task'], '任务类型'),
      framework: decodeHeader(request.headers['x-model-framework'], '模型框架'),
      stage: decodeHeader(request.headers['x-model-stage'], '模型阶段'),
      filename,
      mimeType: request.headers['x-file-mime-type'] || 'application/octet-stream',
    });
    const extension = filename.toLowerCase().split('.').pop();
    if (!extension || !['pt', 'pth', 'onnx', 'safetensors', 'torchscript', 'xml', 'bin'].includes(extension)) throw new HttpError(400, 'INVALID_MODEL_FILE', '仅支持 PT、PTH、ONNX、SafeTensors、TorchScript、OpenVINO XML/BIN 文件');
    const modelId = `model-${randomUUID()}`;
    const artifactId = `artifact-${randomUUID()}`;
    const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const objectKey = `models/${modelId}/${safeFilename}`;
    const root = resolve(config.artifactRoot);
    const filePath = resolve(root, objectKey);
    if (!filePath.startsWith(`${root}${sep}`)) throw new HttpError(400, 'INVALID_MODEL_PATH', '模型文件路径不合法');
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, request.body);
    try {
      const user = (request as AuthenticatedRequest).currentUser;
      const model = await repository.createUploadedModel({ id: modelId, artifactId, ...metadata, objectKey, sizeBytes: request.body.length, sha256: createHash('sha256').update(request.body).digest('hex'), createdBy: user.id });
      await repository.writeAudit({ actorId: user.id, action: 'model.upload', entityType: 'model_version', entityId: model.id, metadata: { filename, sizeBytes: request.body.length } });
      return reply.status(201).send(model);
    } catch (error) {
      await unlink(filePath).catch(() => undefined);
      throw error;
    }
  });
  app.patch('/api/v1/models/:modelId/stage', { preHandler: requireRoles('admin', 'engineer') }, async (request) => {
    const model = await repository.updateModelStage(getId(request, 'modelId'), parseBody(modelStageSchema, request.body).stage);
    if (!model) throw new HttpError(404, 'MODEL_NOT_FOUND', '模型版本不存在');
    await repository.writeAudit({ actorId: (request as AuthenticatedRequest).currentUser.id, action: 'model.stage.update', entityType: 'model_version', entityId: model.id, metadata: { stage: model.stage } });
    return model;
  });
  app.delete('/api/v1/models/:modelId', { preHandler: requireRoles('admin', 'engineer') }, async (request, reply) => {
    const modelId = getId(request, 'modelId');
    const plan = await repository.getModelDeletionPlan(modelId);
    if (!plan) throw new HttpError(404, 'MODEL_NOT_FOUND', '模型版本不存在');
    await removeConversionQueueTasks(plan.conversions);
    if (!await repository.deleteModel(modelId)) throw new HttpError(404, 'MODEL_NOT_FOUND', '模型版本不存在');
    const sourceDirectory = plan.model.sourceJob === 'manual-upload' ? `models/${modelId}` : `training/${plan.model.sourceJob}`;
    const storage = await removeManagedArtifactDirectories(config.artifactRoot, [sourceDirectory, `models/${modelId}`, ...plan.conversions.map((task) => `conversions/${task.id}`)]);
    const result = deletionResult(storage, { removedModels: 1, removedConversions: plan.conversions.length });
    await repository.writeAudit({ actorId: (request as AuthenticatedRequest).currentUser.id, action: 'model.delete', entityType: 'model_version', entityId: modelId, metadata: { name: plan.model.name, version: plan.model.version, ...result } });
    return reply.send(result);
  });
  app.get('/api/v1/conversions', { preHandler: requireRoles('admin', 'engineer', 'annotator') }, async () => ({ items: await repository.listConversions() }));
  app.get('/api/v1/conversions/:conversionId', { preHandler: requireRoles('admin', 'engineer', 'annotator') }, async (request) => {
    const task = await repository.getConversion(getId(request, 'conversionId'));
    if (!task) throw new HttpError(404, 'CONVERSION_NOT_FOUND', '转换任务不存在');
    return task;
  });
  app.post('/api/v1/conversions', { preHandler: requireRoles('admin', 'engineer') }, async (request, reply) => {
    const input = parseBody(conversionRequestSchema, request.body);
    const compatibility = conversionCatalog[input.format];
    if (!compatibility.precisions.includes(input.precision) || !compatibility.targets.includes(input.target)) throw new HttpError(400, 'UNSUPPORTED_CONVERSION_CONFIG', '精度或目标硬件不支持当前格式');
    const sourceModel = await repository.getModelByNameVersion(input.modelName, input.modelVersion);
    if (!sourceModel) throw new HttpError(404, 'SOURCE_MODEL_NOT_FOUND', '源模型版本不存在');
    if (!sourceModel.artifactId) throw new HttpError(409, 'SOURCE_MODEL_ARTIFACT_MISSING', '源模型尚未生成可转换制品');
    const executionTarget = config.gpuEnabled ? 'gpu' : 'cpu';
    if (sourceModel.task === 'sdxl' && executionTarget === 'cpu') throw new HttpError(503, 'SDXL_CONVERSION_GPU_REQUIRED', 'SDXL LoRA 融合与 UNet 转换需要已启用 CUDA 的 GPU Worker');
    const cpuFormats: ConversionTask['format'][] = ['ONNX', 'TorchScript', 'OpenVINO'];
    if (executionTarget === 'cpu' && (!config.cpuOnnxEnabled || !cpuFormats.includes(input.format))) throw new HttpError(503, 'CPU_CONVERSION_UNAVAILABLE', '无显卡部署支持 CPU ONNX、TorchScript 和 OpenVINO 转换，TensorRT 需要 NVIDIA GPU');
    if (executionTarget === 'cpu' && input.precision !== 'FP32') throw new HttpError(400, 'CPU_CONVERSION_PRECISION_UNSUPPORTED', 'CPU 模型转换仅支持 FP32');
    const user = (request as AuthenticatedRequest).currentUser;
    const task = await repository.createConversion({ ...input, createdBy: user.id });
    await queue.enqueue('conversion', task.id, executionTarget);
    await repository.writeAudit({ actorId: user.id, action: 'conversion.create', entityType: 'conversion_job', entityId: task.id, metadata: { format: task.format, target: task.target, executionTarget, sourceModelId: sourceModel.id } });
    return reply.status(202).send(task);
  });
  app.post('/api/v1/conversions/:conversionId/cancel', { preHandler: requireRoles('admin', 'engineer') }, async (request) => {
    const task = await repository.cancelConversion(getId(request, 'conversionId'));
    if (!task) throw new HttpError(404, 'CONVERSION_NOT_FOUND', '转换任务不存在');
    await repository.writeAudit({ actorId: (request as AuthenticatedRequest).currentUser.id, action: 'conversion.cancel', entityType: 'conversion_job', entityId: task.id });
    return task;
  });
  app.delete('/api/v1/conversions/:conversionId', { preHandler: requireRoles('admin', 'engineer') }, async (request, reply) => {
    const conversionId = getId(request, 'conversionId');
    const task = await repository.getConversion(conversionId);
    if (!task) throw new HttpError(404, 'CONVERSION_NOT_FOUND', '转换任务不存在');
    if (task.status === 'queued' || task.status === 'running') throw new HttpError(409, 'CONVERSION_DELETE_NOT_ALLOWED', '排队或运行中的转换任务不能删除，请先取消任务');
    await removeConversionQueueTasks([task]);
    if (!await repository.deleteConversion(conversionId)) throw new HttpError(404, 'CONVERSION_NOT_FOUND', '转换任务不存在');
    const storage = await removeManagedArtifactDirectories(config.artifactRoot, [`conversions/${conversionId}`]);
    const result = deletionResult(storage, { removedConversions: 1 });
    await repository.writeAudit({ actorId: (request as AuthenticatedRequest).currentUser.id, action: 'conversion.delete', entityType: 'conversion_job', entityId: conversionId, metadata: { modelName: task.modelName, modelVersion: task.modelVersion, format: task.format, status: task.status, ...result } });
    return reply.send(result);
  });

  return app;
}
