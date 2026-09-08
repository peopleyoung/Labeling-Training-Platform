import { createReadStream } from 'node:fs';
import { mkdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import bcrypt from 'bcryptjs';
import { imageSize } from 'image-size';
import { ZodError, type ZodType } from 'zod';
import { effectiveUserRoles, type AuthUser, type ConversionTask, type ResourceDeletionResult, type RuntimeCapabilities, type TrainingDraft, type UserRole } from '../shared/contracts';
import { conversionCatalog, findModelVariant, modelCatalog } from '../shared/modelCatalog';
import { annotationJobBatchReviewSchema, annotationJobReassignSchema, annotationJobReleaseSchema, annotationJobReopenSchema, annotationJobReviewSchema, annotationJobUpdateSchema, annotationReviewDecisionSchema, annotationSaveSchema, annotationTaskPauseSchema, conversionRequestSchema, datasetClassesSchema, datasetCreateSchema, datasetLabelsSchema, exportRequestSchema, loginSchema, modelStageSchema, modelUploadMetadataSchema, processingStartSchema, systemSettingsSchema, trainingDraftSchema, uploadSessionCreateSchema, userCreateSchema, userUpdateSchema } from '../shared/schemas';
import { convertCvatPayload, parseCvatXml, validateCvatPayload } from './cvatExchange';
import type { SourceAsset, UploadSession } from '../shared/contracts';
import type { ServerConfig } from './config';
import { HttpError, RepositoryConflictError, RepositoryStateError, isHttpError } from './errors';
import { removeManagedArtifactDirectories, type StorageRemovalSummary } from './artifactCleanup';
import { QueueTaskActiveError, type TaskQueue } from './queue';
import type { Repository, StoredUser } from './repository';
import { diffAnnotations, summarizeAnnotationChanges } from './annotationAttribution';
import { catalogInputSchema, catalogUpdateSchema, dataCenterQuerySchema, datasetBindingSchema } from '../shared/taskCatalog';

interface TokenPayload { userId: string; workspaceId: string }
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

  const expireUploadSession = async (session: UploadSession) => {
    if (new Date(session.expiresAt) >= new Date() || session.status === 'uploaded' || session.status === 'cancelled') return false;
    await repository.updateUploadSession(session.id, { status: 'upload_failed' });
    await rm(resolve(config.artifactRoot, 'upload-sessions', session.id), { recursive: true, force: true });
    return true;
  };

  const findSourceAsset = async (assetId: string) => {
    for (const dataset of await repository.listDatasets()) {
      const asset = (await repository.listDatasetAssets(dataset.id)).find((item) => item.id === assetId);
      if (asset) return asset;
    }
    return null;
  };

  const annotatorImageIds = async (datasetId: string, userId: string) => {
    const jobs = await repository.listAnnotationJobs(datasetId);
    const job = jobs.find((item) => item.assigneeId === userId && ['claimed', 'in_progress', 'rework'].includes(item.status));
    if (!job) return new Set<string>();
    const segment = (await repository.listAnnotationSegments(datasetId)).find((item) => item.id === job.segmentId);
    if (!segment) return new Set<string>();
    const assets = new Map((await repository.listDatasetAssets(datasetId)).map((asset) => [asset.id, asset]));
    const images = (await repository.listDatasetImages(datasetId))
      .filter((image) => {
        if (segment.sourceAssetId !== undefined) return image.sourceAssetId === segment.sourceAssetId;
        return image.sourceAssetId === undefined || assets.get(image.sourceAssetId)?.type !== 'video';
      })
      .sort((left, right) => (left.extractionOrder ?? 0) - (right.extractionOrder ?? 0) || left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
    const start = images.findIndex((image) => image.id === segment.startItemId);
    return new Set(start >= 0 ? images.slice(start, start + segment.itemCount).map((image) => image.id) : []);
  };

  const assertAnnotatorImageAccess = async (datasetId: string, imageId: string, user: StoredUser) => {
    const roles = effectiveUserRoles(user);
    if (roles.includes('admin') || roles.includes('reviewer')) return;
    if (!(await annotatorImageIds(datasetId, user.id)).has(imageId)) throw new HttpError(403, 'ANNOTATION_JOB_ACCESS_DENIED', '只能访问自己当前领取 Job 中的图片');
  };

  const assertDatasetAccess = async (datasetId: string, user: StoredUser) => {
    const dataset = await repository.getDataset(datasetId);
    if (!dataset) throw new HttpError(404, 'DATASET_NOT_FOUND', '数据集不存在');
    if (effectiveUserRoles(user).includes('annotator') && dataset.annotatorIds?.length && !dataset.annotatorIds.includes(user.id)) {
      throw new HttpError(403, 'DATASET_ACCESS_DENIED', '当前标注员未被分配到该数据集');
    }
    return dataset;
  };

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
    if (!user || !user.enabled || user.workspaceId !== token.workspaceId) {
      throw new HttpError(401, 'UNAUTHORIZED', '登录状态已失效，请重新登录');
    }
    (request as AuthenticatedRequest).currentUser = user;
  };

  const requireRoles = (...roles: UserRole[]) => async (request: FastifyRequest, reply: FastifyReply) => {
    await authenticate(request, reply);
    const allowed = new Set(roles.flatMap((role) => role === 'reviewer' ? ['reviewer', 'reviewer'] : [role]));
    if (!effectiveUserRoles((request as AuthenticatedRequest).currentUser).some((role) => allowed.has(role))) {
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

  const enqueueTrainingJob = async (draft: TrainingDraft, user: StoredUser, retrySourceId?: string, existingSnapshotId?: string) => {
    if (!config.gpuEnabled && !config.cpuTrainingEnabled) throw new HttpError(503, 'TRAINING_WORKER_UNAVAILABLE', '当前部署未启用可用的训练 Worker');
    const model = findModelVariant(draft.model);
    if (!model || model.task !== draft.type) throw new HttpError(400, 'UNSUPPORTED_MODEL', '所选模型不支持当前训练任务');
    if (!(model.dataFormats as readonly string[]).includes(draft.dataFormat)) throw new HttpError(400, 'UNSUPPORTED_MODEL_DATA_FORMAT', '所选模型与数据格式不兼容');
    if (draft.type === 'sdxl' && !config.gpuEnabled) throw new HttpError(503, 'SDXL_GPU_REQUIRED', 'SDXL 训练需要已启用 CUDA 的 GPU Worker');
    if (draft.type === 'sdxl' && draft.weightSource !== 'pretrained') throw new HttpError(400, 'SDXL_BASE_MODEL_REQUIRED', 'SDXL LoRA 训练必须使用预置的 SDXL Base 模型');
    if (await repository.getModelByNameVersion(draft.name, draft.version)) throw new HttpError(409, 'MODEL_VERSION_EXISTS', '同名模型版本已存在，请修改任务名称或模型版本');
    const dataset = await repository.getDataset(draft.datasetId);
    if (!dataset) throw new HttpError(404, 'DATASET_NOT_FOUND', '数据集不存在');
    if (config.gpuEnabled && !draft.mixedPrecision && model.minGpuMemoryGb >= 12) throw new HttpError(400, 'GPU_MEMORY_POLICY', 'T4 16GB 上的该模型必须启用混合精度');
    const executionTarget = config.gpuEnabled ? 'gpu' : 'cpu';
    const effectiveDraft = executionTarget === 'cpu' ? { ...draft, gpu: 'CPU', mixedPrecision: false } : draft;
    let snapshot;
    try {
      snapshot = existingSnapshotId ? await repository.getTrainingSnapshot(existingSnapshotId) : await repository.createTrainingSnapshot({ datasetId: dataset.id, jobIds: draft.jobIds, createdBy: user.id });
    } catch (error) {
      if (!draft.jobIds?.length && error instanceof RepositoryStateError && error.code === 'TRAINING_APPROVED_JOBS_REQUIRED') throw new HttpError(409, 'DATASET_REVIEW_REQUIRED', '数据集全部标注审核通过后才能训练');
      throw error;
    }
    if (!snapshot) throw new HttpError(409, 'TRAINING_SNAPSHOT_UNAVAILABLE', '训练快照不存在，无法重试');
    const job = await repository.createTrainingJob({ draft: effectiveDraft, datasetName: `${dataset.name} ${dataset.version}`, createdBy: user.id, retrySourceId, snapshotId: snapshot.id });
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
    if (!user.enabled) throw new HttpError(401, 'INVALID_CREDENTIALS', '账号或密码不正确');
    const accessToken = await reply.jwtSign({ userId: user.id, workspaceId: user.workspaceId }, { expiresIn: '8h' });
    await repository.writeAudit({ actorId: user.id, action: 'auth.login', entityType: 'user', entityId: user.id });
    return { accessToken, user: toAuthUser(user) };
  });

  app.get('/api/v1/auth/me', { preHandler: authenticate }, async (request) => toAuthUser((request as AuthenticatedRequest).currentUser));
  app.get('/api/v1/users', { preHandler: requireRoles('admin') }, async () => ({ items: await repository.listUsers() }));
  app.post('/api/v1/users', { preHandler: requireRoles('admin') }, async (request, reply) => {
    const user = await repository.createUser(parseBody(userCreateSchema, request.body));
    const actor = (request as AuthenticatedRequest).currentUser;
    await repository.writeAudit({ actorId: actor.id, action: 'user.create', entityType: 'user', entityId: user.id, metadata: { roles: user.roles } });
    return reply.status(201).send(user);
  });
  app.patch('/api/v1/users/:userId', { preHandler: requireRoles('admin') }, async (request) => {
    const userId = getId(request, 'userId');
    const user = await repository.updateUser(userId, parseBody(userUpdateSchema, request.body));
    if (!user) throw new HttpError(404, 'USER_NOT_FOUND', '用户不存在');
    await repository.writeAudit({ actorId: (request as AuthenticatedRequest).currentUser.id, action: 'user.update', entityType: 'user', entityId: user.id, metadata: { roles: user.roles, enabled: user.enabled } });
    return user;
  });
  app.delete('/api/v1/users/:userId', { preHandler: requireRoles('admin') }, async (request) => {
    const userId = getId(request, 'userId');
    const actor = (request as AuthenticatedRequest).currentUser;
    if (userId === actor.id) throw new HttpError(400, 'USER_DELETE_SELF', '不能删除当前登录的管理员账号');
    const target = await repository.findUserById(userId);
    if (!target) throw new HttpError(404, 'USER_NOT_FOUND', '用户不存在');
    if (effectiveUserRoles(target).includes('admin')) {
      const admins = (await repository.listUsers()).filter((user) => user.enabled !== false && effectiveUserRoles(user).includes('admin'));
      if (admins.length <= 1) throw new HttpError(400, 'LAST_ADMIN_REQUIRED', '系统至少需要保留一个启用中的管理员账号');
    }
    const deleted = await repository.deleteUser(userId);
    if (!deleted) throw new HttpError(404, 'USER_NOT_FOUND', '用户不存在');
    await repository.writeAudit({ actorId: actor.id, action: 'user.delete', entityType: 'user', entityId: userId, metadata: { username: target.username, displayName: target.displayName } });
    return { deleted: true, userId };
  });
  app.get('/api/v1/settings', { preHandler: requireRoles('admin') }, async () => repository.getSettings());
  app.patch('/api/v1/settings', { preHandler: requireRoles('admin') }, async (request) => {
    const settings = await repository.updateSettings(parseBody(systemSettingsSchema, request.body));
    await repository.writeAudit({ actorId: (request as AuthenticatedRequest).currentUser.id, action: 'settings.update', entityType: 'system_settings', entityId: 'default', metadata: settings as unknown as Record<string, unknown> });
    return settings;
  });
  app.get('/api/v1/task-categories', { preHandler: requireRoles('admin') }, async () => repository.catalog.list());
  app.post('/api/v1/task-categories', { preHandler: requireRoles('admin') }, async (request, reply) => reply.status(201).send(await repository.catalog.save('category', null, parseBody(catalogInputSchema, request.body), (request as AuthenticatedRequest).currentUser.id)));
  app.patch('/api/v1/task-categories/:id', { preHandler: requireRoles('admin') }, async (request) => repository.catalog.save('category', getId(request, 'id'), parseBody(catalogUpdateSchema, request.body), (request as AuthenticatedRequest).currentUser.id));
  app.post('/api/v1/task-categories/:id/task-types', { preHandler: requireRoles('admin') }, async (request, reply) => reply.status(201).send(await repository.catalog.save('task', null, parseBody(catalogInputSchema, request.body), (request as AuthenticatedRequest).currentUser.id, getId(request, 'id'))));
  app.patch('/api/v1/task-types/:id', { preHandler: requireRoles('admin') }, async (request) => repository.catalog.save('task', getId(request, 'id'), parseBody(catalogUpdateSchema, request.body), (request as AuthenticatedRequest).currentUser.id));
  app.get('/api/v1/data-center/tree', { preHandler: requireRoles('admin') }, async (request) => repository.catalog.tree(parseBody(dataCenterQuerySchema, request.query)));
  app.patch('/api/v1/datasets/:datasetId/task-type', { preHandler: requireRoles('admin') }, async (request) => {
    const input = parseBody(datasetBindingSchema, request.body);
    const datasetId = getId(request, 'datasetId');
    await repository.catalog.bind(datasetId, input.taskTypeId, input.expectedTaskTypeId, (request as AuthenticatedRequest).currentUser.id);
    return repository.getDataset(datasetId);
  });
  app.get('/api/v1/catalog/models', { preHandler: requireRoles('admin', 'reviewer') }, async () => ({ items: modelCatalog }));
  app.get('/api/v1/activities', { preHandler: requireRoles('admin', 'reviewer') }, async () => ({ items: await repository.listRecentActivities(5) }));
  app.get('/api/v1/annotation-statistics', { preHandler: requireRoles('admin', 'reviewer', 'annotator') }, async (request) => {
    const datasetId = String((request.query as { datasetId?: string }).datasetId ?? '').trim() || undefined;
    if (datasetId) await assertDatasetAccess(datasetId, (request as AuthenticatedRequest).currentUser);
    const user = (request as AuthenticatedRequest).currentUser;
    return repository.getAnnotationStatistics(datasetId, { id: user.id, role: user.role });
  });
  app.get('/api/v1/annotation-statistics/annotators', { preHandler: requireRoles('admin') }, async (request) => {
    const query = request.query as { startDate?: string; endDate?: string };
    const startDate = query.startDate?.trim() || undefined;
    const endDate = query.endDate?.trim() || undefined;
    if ((startDate && !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) || (endDate && !/^\d{4}-\d{2}-\d{2}$/.test(endDate))) throw new HttpError(400, 'INVALID_DATE_RANGE', '日期格式必须为 YYYY-MM-DD');
    if (startDate && endDate && startDate > endDate) throw new HttpError(400, 'INVALID_DATE_RANGE', '开始日期不能晚于结束日期');
    return { items: await repository.getAnnotatorPerformance({ startDate, endDate }) };
  });

  app.get('/api/v1/datasets', { preHandler: requireRoles('admin', 'reviewer', 'annotator') }, async (request) => {
    const user = (request as AuthenticatedRequest).currentUser;
    const datasets = await repository.listDatasets();
    return { items: effectiveUserRoles(user).includes('annotator') ? datasets.filter((dataset) => !dataset.annotatorIds?.length || dataset.annotatorIds.includes(user.id)) : datasets };
  });
  app.get('/api/v1/datasets/:datasetId', { preHandler: requireRoles('admin', 'reviewer', 'annotator') }, async (request) => {
    return assertDatasetAccess(getId(request, 'datasetId'), (request as AuthenticatedRequest).currentUser);
  });
  app.post('/api/v1/datasets', { preHandler: requireRoles('admin') }, async (request, reply) => {
    const input = parseBody(datasetCreateSchema, request.body);
    const annotatorIds = input.annotatorIds ?? [];
    const reviewerIds = input.reviewerIds ?? [];
    const selectedIds = new Set([...annotatorIds, ...reviewerIds]);
    const selectedUsers = await Promise.all([...selectedIds].map((id) => repository.findUserById(id)));
    const usersById = new Map(selectedUsers.filter((user): user is NonNullable<typeof user> => Boolean(user)).map((user) => [user.id, user]));
    if (usersById.size !== selectedIds.size || [...usersById.values()].some((user) => user.enabled === false) || annotatorIds.some((id) => !(usersById.get(id)?.roles ?? [usersById.get(id)?.role]).includes('annotator')) || reviewerIds.some((id) => !(usersById.get(id)?.roles ?? [usersById.get(id)?.role]).includes('reviewer'))) throw new HttpError(400, 'DATASET_MEMBER_INVALID', '标注员或审核员账号无效');
    const dataset = await repository.createDataset(input);
    await repository.writeAudit({ actorId: (request as AuthenticatedRequest).currentUser.id, action: 'dataset.create', entityType: 'dataset', entityId: dataset.id, metadata: { name: dataset.name } });
    return reply.status(201).send(dataset);
  });
  app.get('/api/v1/datasets/:datasetId/annotation-task', { preHandler: requireRoles('admin', 'reviewer', 'annotator') }, async (request) => {
    const datasetId = getId(request, 'datasetId');
    await assertDatasetAccess(datasetId, (request as AuthenticatedRequest).currentUser);
    return repository.getAnnotationTask(datasetId);
  });
  app.post('/api/v1/datasets/:datasetId/annotation-task/pause', { preHandler: requireRoles('admin') }, async (request) => {
    const datasetId = getId(request, 'datasetId');
    const input = parseBody(annotationTaskPauseSchema, request.body);
    const task = await repository.updateAnnotationTaskStatus(datasetId, 'paused');
    if (!task) throw new HttpError(404, 'ANNOTATION_TASK_NOT_FOUND', '标注任务不存在');
    await repository.writeAudit({ actorId: (request as AuthenticatedRequest).currentUser.id, action: 'annotation_task.pause', entityType: 'annotation_task', entityId: task.id, metadata: { datasetId, reason: input.reason } });
    return task;
  });
  app.post('/api/v1/datasets/:datasetId/annotation-task/resume', { preHandler: requireRoles('admin') }, async (request) => {
    const datasetId = getId(request, 'datasetId');
    const current = await repository.getAnnotationTask(datasetId);
    if (!current) throw new HttpError(404, 'ANNOTATION_TASK_NOT_FOUND', '标注任务不存在');
    if (current.status !== 'paused') throw new HttpError(409, 'ANNOTATION_TASK_NOT_PAUSED', '只有已暂停的标注任务可以恢复');
    const task = await repository.updateAnnotationTaskStatus(datasetId, 'annotating');
    await repository.writeAudit({ actorId: (request as AuthenticatedRequest).currentUser.id, action: 'annotation_task.resume', entityType: 'annotation_task', entityId: current.id, metadata: { datasetId } });
    return task;
  });
  app.post('/api/v1/datasets/:datasetId/annotation-task/open', { preHandler: requireRoles('admin') }, async (request) => {
    const datasetId = getId(request, 'datasetId');
    const task = await repository.getAnnotationTask(datasetId);
    if (!task) throw new HttpError(404, 'ANNOTATION_TASK_NOT_FOUND', '标注任务不存在');
    if (task.status !== 'ready') throw new HttpError(409, 'ANNOTATION_TASK_NOT_READY', '资源处理尚未完成，不能开放标注');
    const jobs = await repository.listAnnotationJobs(datasetId);
    if (!jobs.length) throw new HttpError(409, 'ANNOTATION_TASK_NOT_READY', '当前任务没有可标注的 Job');
    const opened = await repository.updateAnnotationTaskStatus(datasetId, 'annotating');
    if (!opened) throw new HttpError(404, 'ANNOTATION_TASK_NOT_FOUND', '标注任务不存在');
    await repository.writeAudit({ actorId: (request as AuthenticatedRequest).currentUser.id, action: 'annotation_task.open', entityType: 'annotation_task', entityId: opened.id, metadata: { datasetId, jobCount: jobs.length } });
    return opened;
  });
  app.get('/api/v1/datasets/:datasetId/assets', { preHandler: requireRoles('admin', 'reviewer') }, async (request) => {
    const datasetId = getId(request, 'datasetId');
    if (!await repository.getDataset(datasetId)) throw new HttpError(404, 'DATASET_NOT_FOUND', '数据集不存在');
    return { items: await repository.listDatasetAssets(datasetId) };
  });
  app.get('/api/v1/source-assets/:assetId/download', { preHandler: requireRoles('admin', 'reviewer') }, async (request, reply) => {
    const asset = await findSourceAsset(getId(request, 'assetId'));
    if (!asset?.objectKey || asset.uploadStatus !== 'uploaded') throw new HttpError(404, 'SOURCE_ASSET_NOT_FOUND', '原始资源不存在或尚未上传完成');
    const root = resolve(config.artifactRoot);
    const filePath = resolve(root, asset.objectKey);
    if (!filePath.startsWith(`${root}${sep}`)) throw new HttpError(400, 'INVALID_SOURCE_ASSET_PATH', '原始资源路径不合法');
    try {
      await stat(filePath);
    } catch {
      throw new HttpError(404, 'SOURCE_ASSET_CONTENT_NOT_FOUND', '原始资源文件暂不可用');
    }
    await repository.writeAudit({ actorId: (request as AuthenticatedRequest).currentUser.id, action: 'source_asset.download', entityType: 'source_asset', entityId: asset.id, metadata: { datasetId: asset.datasetId } });
    return reply.type(asset.mimeType).header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(asset.filename)}`).send(createReadStream(filePath));
  });
  app.get('/api/v1/datasets/:datasetId/processing-runs', { preHandler: requireRoles('admin', 'reviewer') }, async (request) => {
    const datasetId = getId(request, 'datasetId');
    if (!await repository.getDataset(datasetId)) throw new HttpError(404, 'DATASET_NOT_FOUND', '数据集不存在');
    return { items: await repository.listProcessingRuns(datasetId) };
  });
  app.get('/api/v1/datasets/:datasetId/segments', { preHandler: requireRoles('admin', 'reviewer', 'annotator') }, async (request) => {
    const datasetId = getId(request, 'datasetId');
    const user = (request as AuthenticatedRequest).currentUser;
    await assertDatasetAccess(datasetId, user);
    const segments = await repository.listAnnotationSegments(datasetId);
    if (effectiveUserRoles(user).some((role) => role === 'admin' || role === 'reviewer')) return { items: segments };
    const assignedSegmentIds = new Set((await repository.listAnnotationJobs(datasetId)).filter((job) => job.assigneeId === user.id).map((job) => job.segmentId));
    return { items: segments.filter((segment) => assignedSegmentIds.has(segment.id)) };
  });
  app.get('/api/v1/datasets/:datasetId/jobs', { preHandler: requireRoles('admin', 'reviewer', 'annotator') }, async (request) => {
    const datasetId = getId(request, 'datasetId');
    const user = (request as AuthenticatedRequest).currentUser;
    await assertDatasetAccess(datasetId, user);
    const jobs = await repository.listAnnotationJobs(datasetId);
    const operational = effectiveUserRoles(user).some((role) => role === 'admin' || role === 'reviewer');
    return { items: operational ? jobs : jobs.filter((job) => job.assigneeId === user.id || (job.status === 'available' && !job.assigneeId)) };
  });
  app.post('/api/v1/datasets/:datasetId/jobs/claim-next', { preHandler: requireRoles('annotator') }, async (request, reply) => {
    const datasetId = getId(request, 'datasetId');
    const task = await repository.getAnnotationTask(datasetId);
    if (!task) throw new HttpError(404, 'ANNOTATION_TASK_NOT_FOUND', '标注任务不存在');
    if (task.status === 'paused') throw new HttpError(409, 'ANNOTATION_TASK_PAUSED', '标注任务已暂停，暂时不能领取 Job');
    if (task.status !== 'annotating') throw new HttpError(409, 'ANNOTATION_TASK_NOT_OPEN', '管理员尚未开放标注任务');
    const user = (request as AuthenticatedRequest).currentUser;
    const job = await repository.claimNextAnnotationJob(datasetId, user.id);
    if (!job) throw new HttpError(409, 'NO_AVAILABLE_ANNOTATION_JOB', '当前没有可领取的标注任务');
    await repository.writeAudit({ actorId: user.id, action: 'annotation_job.claim', entityType: 'annotation_job', entityId: job.id, metadata: { datasetId, sequence: job.sequence } });
    return reply.status(200).send(job);
  });
  app.post('/api/v1/annotation-jobs/:jobId/release', { preHandler: requireRoles('admin') }, async (request) => {
    const input = parseBody(annotationJobReleaseSchema, request.body);
    const user = (request as AuthenticatedRequest).currentUser;
    const force = effectiveUserRoles(user).includes('admin');
    const job = await repository.releaseAnnotationJob(getId(request, 'jobId'), user.id, force);
    if (!job) throw new HttpError(409, 'ANNOTATION_JOB_RELEASE_INVALID_STATE', '只能释放自己领取且尚未提交的 Job');
    await repository.writeAudit({ actorId: user.id, action: 'annotation_job.release', entityType: 'annotation_job', entityId: job.id, metadata: { reason: input.reason, force } });
    return job;
  });
  app.post('/api/v1/annotation-jobs/:jobId/reassign', { preHandler: requireRoles('admin') }, async (request) => {
    const input = parseBody(annotationJobReassignSchema, request.body);
    const assignee = await repository.findUserById(input.assigneeId);
    if (!assignee || !assignee.enabled || !effectiveUserRoles(assignee).includes('annotator')) throw new HttpError(400, 'ANNOTATION_ASSIGNEE_INVALID', '目标用户必须是已启用的标注员');
    const job = await repository.reassignAnnotationJob(getId(request, 'jobId'), assignee.id);
    if (!job) throw new HttpError(409, 'ANNOTATION_JOB_REASSIGN_INVALID_STATE', '当前 Job 状态不允许重新指派');
    await repository.writeAudit({ actorId: (request as AuthenticatedRequest).currentUser.id, action: 'annotation_job.reassign', entityType: 'annotation_job', entityId: job.id, metadata: { assigneeId: assignee.id, reason: input.reason } });
    return job;
  });
  app.post('/api/v1/annotation-jobs/:jobId/submit', { preHandler: requireRoles('annotator') }, async (request, reply) => {
    const job = await repository.getAnnotationJob(getId(request, 'jobId'));
    const user = (request as AuthenticatedRequest).currentUser;
    if (!job) throw new HttpError(404, 'ANNOTATION_JOB_NOT_FOUND', '标注任务不存在');
    if (job.assigneeId !== user.id) throw new HttpError(403, 'ANNOTATION_JOB_OWNER_REQUIRED', '只能提交自己领取的标注任务');
    if (!['claimed', 'in_progress', 'rework'].includes(job.status)) throw new HttpError(409, 'ANNOTATION_JOB_INVALID_STATE', '当前标注任务不能提交');
    const updated = await repository.submitAnnotationJob(job.id, user.id);
    if (!updated) throw new HttpError(409, 'ANNOTATION_JOB_INVALID_STATE', '当前标注任务不能提交');
    await repository.writeAudit({ actorId: user.id, action: 'annotation_job.submit', entityType: 'annotation_job', entityId: job.id, metadata: { datasetId: job.datasetId } });
    return reply.status(200).send(updated);
  });
  app.post('/api/v1/datasets/:datasetId/review-jobs/claim-next', { preHandler: requireRoles('admin', 'reviewer') }, async (request, reply) => {
    const datasetId = getId(request, 'datasetId');
    if (!await repository.getDataset(datasetId)) throw new HttpError(404, 'DATASET_NOT_FOUND', '数据集不存在');
    const user = (request as AuthenticatedRequest).currentUser;
    const job = await repository.claimNextAnnotationReviewJob(datasetId, user.id, effectiveUserRoles(user).includes('admin'));
    if (!job) throw new HttpError(404, 'NO_REVIEW_JOB_AVAILABLE', '当前没有可审核的 Job');
    await repository.writeAudit({ actorId: user.id, action: 'annotation_job.review_claim', entityType: 'annotation_job', entityId: job.id, metadata: { datasetId, sequence: job.sequence } });
    return reply.status(200).send(job);
  });
  app.post('/api/v1/annotation-jobs/:jobId/review-claim', { preHandler: requireRoles('admin', 'reviewer') }, async (request, reply) => {
    const user = (request as AuthenticatedRequest).currentUser;
    const job = await repository.claimAnnotationReviewJob(getId(request, 'jobId'), user.id, effectiveUserRoles(user).includes('admin'));
    if (!job) throw new HttpError(409, 'ANNOTATION_JOB_REVIEW_UNAVAILABLE', '当前任务段不可领取审核');
    await repository.writeAudit({ actorId: user.id, action: 'annotation_job.review_claim', entityType: 'annotation_job', entityId: job.id, metadata: { datasetId: job.datasetId, sequence: job.sequence, selected: true } });
    return reply.status(200).send(job);
  });
  app.put('/api/v1/annotation-jobs/:jobId/images/:imageId/annotations', { preHandler: requireRoles('admin', 'reviewer') }, async (request, reply) => {
    const job = await repository.getAnnotationJob(getId(request, 'jobId'));
    if (!job) throw new HttpError(404, 'ANNOTATION_JOB_NOT_FOUND', '标注任务不存在');
    const user = (request as AuthenticatedRequest).currentUser;
    if (job.reviewerId !== user.id || job.status !== 'reviewing') throw new HttpError(409, 'ANNOTATION_JOB_REVIEW_LOCKED', '当前审核员未锁定该 Job');
    const input = parseBody(annotationSaveSchema, request.body);
    const imageId = getId(request, 'imageId');
    const before = await repository.getAnnotations(job.datasetId, imageId);
    const document = await repository.saveAnnotations({ datasetId: job.datasetId, imageId, ...input, updatedBy: user.id, updatedByRole: user.role, reviewJobId: job.id, reviewerId: user.id });
    const changes = diffAnnotations(before?.annotations ?? [], document.annotations);
    await repository.writeAudit({ actorId: user.id, action: 'annotation_job.review_save', entityType: 'annotation_document', entityId: `${job.id}:${imageId}`, metadata: { datasetId: job.datasetId, imageId, jobId: job.id, reviewerId: user.id, revision: document.revision, changes, counts: summarizeAnnotationChanges(changes) } });
    return reply.status(200).send(document);
  });
  app.post('/api/v1/annotation-jobs/:jobId/review', { preHandler: requireRoles('admin', 'reviewer') }, async (request, reply) => {
    const job = await repository.getAnnotationJob(getId(request, 'jobId'));
    if (!job) throw new HttpError(404, 'ANNOTATION_JOB_NOT_FOUND', '标注任务不存在');
    const input = parseBody(annotationJobReviewSchema, request.body);
    const user = (request as AuthenticatedRequest).currentUser;
    if (job.assigneeId === user.id) throw new HttpError(403, 'ANNOTATION_SELF_REVIEW_FORBIDDEN', '不能审核自己提交的 Job');
    if (input.decision === 'reject' && !input.comment) throw new HttpError(400, 'REVIEW_COMMENT_REQUIRED', '驳回必须填写原因');
    const updated = await repository.reviewAnnotationJob(job.id, user.id, input.decision, input.comment);
    if (!updated) throw new HttpError(409, 'ANNOTATION_JOB_REVIEW_LOCKED', 'Job 未由当前审核员锁定或已被处理');
    await repository.writeAudit({ actorId: user.id, action: `annotation_job.review_${input.decision}`, entityType: 'annotation_job', entityId: job.id, metadata: { comment: input.comment, assigneeId: job.assigneeId } });
    return reply.status(200).send(updated);
  });
  app.post('/api/v1/datasets/:datasetId/review-jobs/review', { preHandler: requireRoles('admin', 'reviewer') }, async (request, reply) => {
    const datasetId = getId(request, 'datasetId');
    const input = parseBody(annotationJobBatchReviewSchema, request.body);
    const user = (request as AuthenticatedRequest).currentUser;
    const jobs = await Promise.all(input.jobIds.map((id) => repository.getAnnotationJob(id)));
    if (jobs.some((job) => !job || job.datasetId !== datasetId)) throw new HttpError(404, 'ANNOTATION_JOB_NOT_FOUND', '批量审核包含不存在或不属于当前数据集的 Job');
    if (jobs.some((job) => job?.assigneeId === user.id)) throw new HttpError(403, 'ANNOTATION_SELF_REVIEW_FORBIDDEN', '不能审核自己提交的 Job');
    if (jobs.some((job) => job?.status !== 'reviewing' || job.reviewerId !== user.id)) throw new HttpError(409, 'ANNOTATION_JOB_REVIEW_LOCKED', '批量审核包含未由当前审核员锁定的 Job');
    const reviewed = await repository.reviewAnnotationJobs(input.jobIds, user.id, input.decision, input.comment);
    if (reviewed.length !== new Set(input.jobIds).size) throw new HttpError(409, 'ANNOTATION_JOB_REVIEW_INCOMPLETE', '批量审核未能完整处理所选 Job');
    for (const job of reviewed) await repository.writeAudit({ actorId: user.id, action: `annotation_job.review_${input.decision}`, entityType: 'annotation_job', entityId: job.id, metadata: { datasetId, batch: true, comment: input.comment } });
    return reply.status(200).send({ items: reviewed, requested: input.jobIds.length });
  });
  app.post('/api/v1/annotation-jobs/:jobId/reopen', { preHandler: requireRoles('admin') }, async (request, reply) => {
    const jobId = getId(request, 'jobId');
    const input = parseBody(annotationJobReopenSchema, request.body);
    const user = (request as AuthenticatedRequest).currentUser;
    const updated = await repository.reopenAnnotationJob(jobId, user.id, input.reason);
    if (!updated) throw new HttpError(409, 'ANNOTATION_JOB_REOPEN_INVALID_STATE', '只有已通过的 Job 可以重新开放');
    await repository.writeAudit({ actorId: user.id, action: 'annotation_job.reopen', entityType: 'annotation_job', entityId: jobId, metadata: { reason: input.reason } });
    return reply.status(200).send(updated);
  });
  app.patch('/api/v1/annotation-jobs/:jobId', { preHandler: requireRoles('admin', 'reviewer') }, async (request) => {
    const job = await repository.getAnnotationJob(getId(request, 'jobId'));
    if (!job) throw new HttpError(404, 'ANNOTATION_JOB_NOT_FOUND', '标注任务不存在');
    const input = parseBody(annotationJobUpdateSchema, request.body);
    if (input.status === 'rework' && !input.reviewComment) throw new HttpError(400, 'REWORK_REASON_REQUIRED', '退回重做必须填写原因');
    const updated = await repository.updateAnnotationJob(job.id, { status: input.status, assigneeId: input.assigneeId, reviewComment: input.reviewComment });
    await repository.writeAudit({ actorId: (request as AuthenticatedRequest).currentUser.id, action: `annotation_job.${input.status ?? 'update'}`, entityType: 'annotation_job', entityId: job.id, metadata: { assigneeId: input.assigneeId, reviewComment: input.reviewComment } });
    return updated;
  });
  app.post('/api/v1/datasets/:datasetId/process', { preHandler: requireRoles('admin') }, async (request, reply) => {
    const datasetId = getId(request, 'datasetId');
    const dataset = await repository.getDataset(datasetId);
    if (!dataset) throw new HttpError(404, 'DATASET_NOT_FOUND', '数据集不存在');
    const assets = await repository.listDatasetAssets(datasetId);
    const processable = assets.filter((asset) => asset.uploadStatus === 'uploaded' && asset.processingStatus !== 'processed');
    if (!processable.length) throw new HttpError(409, 'NO_PROCESSABLE_ASSETS', '没有等待处理的已上传资源');
    const input = parseBody(processingStartSchema, { ...(dataset.processingConfig ?? {}), ...((request.body ?? {}) as object) });
    const run = await repository.createProcessingRun({ datasetId, ...input });
    await queue.enqueue('processing', run.id, 'cpu');
    await repository.writeAudit({ actorId: (request as AuthenticatedRequest).currentUser.id, action: 'dataset.processing.start', entityType: 'processing_run', entityId: run.id, metadata: { datasetId, assetCount: processable.length, extractionStrategy: input.extractionStrategy } });
    return reply.status(202).send(run);
  });
  app.post('/api/v1/source-assets/:assetId/retry-processing', { preHandler: requireRoles('admin') }, async (request, reply) => {
    const assetId = getId(request, 'assetId');
    const asset = await findSourceAsset(assetId);
    if (!asset) throw new HttpError(404, 'ASSET_NOT_FOUND', '资源不存在');
    if (asset.type !== 'video' || !['failed', 'partial_failed'].includes(asset.processingStatus)) throw new HttpError(409, 'ASSET_NOT_RETRYABLE', '仅失败的视频资源可以独立重试');
    const dataset = await repository.getDataset(asset.datasetId);
    const input = parseBody(processingStartSchema, { ...(dataset?.processingConfig ?? {}), ...((request.body ?? {}) as object) });
    const run = await repository.createProcessingRun({ datasetId: asset.datasetId, sourceAssetId: asset.id, ...input });
    await queue.enqueue('processing', run.id, 'cpu');
    return reply.status(202).send(run);
  });
  app.post('/api/v1/datasets/:datasetId/upload-sessions', { preHandler: requireRoles('admin') }, async (request, reply) => {
    const datasetId = getId(request, 'datasetId');
    if (!await repository.getDataset(datasetId)) throw new HttpError(404, 'DATASET_NOT_FOUND', '数据集不存在');
    const input = parseBody(uploadSessionCreateSchema, request.body);
    const partSize = 8 * 1024 * 1024;
    const totalParts = Math.ceil(input.sizeBytes / partSize);
    const assetToken = randomUUID();
    const asset = await repository.createSourceAsset({ datasetId, type: input.type, filename: input.filename, mimeType: input.mimeType, sizeBytes: input.sizeBytes, sha256: input.sha256, objectKey: `datasets/${datasetId}/assets/${assetToken}/original` });
    const session = await repository.createUploadSession({ datasetId, assetId: asset.id, filename: input.filename, mimeType: input.mimeType, sizeBytes: input.sizeBytes, partSize, totalParts, expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() });
    await repository.updateUploadSession(session.id, { status: 'uploading' });
    await mkdir(resolve(config.artifactRoot, 'upload-sessions', session.id, 'parts'), { recursive: true });
    await repository.writeAudit({ actorId: (request as AuthenticatedRequest).currentUser.id, action: 'asset.upload.start', entityType: 'source_asset', entityId: asset.id, metadata: { datasetId, filename: input.filename, type: input.type, sizeBytes: input.sizeBytes } });
    return reply.status(201).send({ ...session, status: 'uploading', asset });
  });
  app.get('/api/v1/datasets/:datasetId/upload-sessions', { preHandler: requireRoles('admin') }, async (request) => {
    const datasetId = getId(request, 'datasetId');
    if (!await repository.getDataset(datasetId)) throw new HttpError(404, 'DATASET_NOT_FOUND', '数据集不存在');
    const sessions = await repository.listUploadSessions(datasetId);
    await Promise.all(sessions.map(expireUploadSession));
    return { items: await repository.listUploadSessions(datasetId) };
  });
  app.get('/api/v1/upload-sessions/:sessionId', { preHandler: requireRoles('admin') }, async (request) => {
    const session = await repository.getUploadSession(getId(request, 'sessionId'));
    if (!session) throw new HttpError(404, 'UPLOAD_SESSION_NOT_FOUND', '上传会话不存在');
    await expireUploadSession(session);
    return repository.getUploadSession(session.id);
  });
  app.put('/api/v1/upload-sessions/:sessionId/parts/:partNumber', { preHandler: requireRoles('admin') }, async (request, reply) => {
    const session = await repository.getUploadSession(getId(request, 'sessionId'));
    const partNumber = Number((request.params as { partNumber?: string }).partNumber);
    if (!session) throw new HttpError(404, 'UPLOAD_SESSION_NOT_FOUND', '上传会话不存在');
    if (await expireUploadSession(session)) throw new HttpError(409, 'UPLOAD_SESSION_EXPIRED', '上传会话已过期，请重新上传');
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > session.totalParts) throw new HttpError(400, 'INVALID_UPLOAD_PART', '分片序号不合法');
    if (session.status === 'cancelled' || session.status === 'uploaded') throw new HttpError(409, 'UPLOAD_SESSION_CLOSED', '上传会话已关闭');
    if (!Buffer.isBuffer(request.body) || request.body.length === 0) throw new HttpError(400, 'INVALID_UPLOAD_PART', '分片不能为空');
    const partPath = resolve(config.artifactRoot, 'upload-sessions', session.id, 'parts', String(partNumber));
    await mkdir(dirname(partPath), { recursive: true });
    await writeFile(partPath, request.body);
    const updated = await repository.updateUploadSession(session.id, { completedParts: [...session.completedParts, partNumber], status: 'uploading' });
    return reply.send({ partNumber, sizeBytes: request.body.length, completedParts: updated?.completedParts ?? [] });
  });
  app.post('/api/v1/upload-sessions/:sessionId/complete', { preHandler: requireRoles('admin') }, async (request, reply) => {
    const session = await repository.getUploadSession(getId(request, 'sessionId'));
    if (!session) throw new HttpError(404, 'UPLOAD_SESSION_NOT_FOUND', '上传会话不存在');
    if (await expireUploadSession(session)) throw new HttpError(409, 'UPLOAD_SESSION_EXPIRED', '上传会话已过期，请重新上传');
    if (session.completedParts.length !== session.totalParts || session.completedParts.some((part, index) => part !== index + 1)) throw new HttpError(409, 'UPLOAD_INCOMPLETE', '仍有分片未上传完成');
    const asset = (await repository.listDatasetAssets(session.datasetId)).find((item) => item.id === session.assetId);
    if (!asset) throw new HttpError(404, 'ASSET_NOT_FOUND', '资源不存在');
    const uploadDir = resolve(config.artifactRoot, 'upload-sessions', session.id, 'parts');
    const target = resolve(config.artifactRoot, asset.objectKey ?? '');
    await mkdir(dirname(target), { recursive: true });
    const hash = createHash('sha256');
    let totalBytes = 0;
    const output = await import('node:fs').then(({ createWriteStream }) => createWriteStream(target));
    for (let part = 1; part <= session.totalParts; part += 1) {
      const chunk = await readFile(resolve(uploadDir, String(part)));
      totalBytes += chunk.length;
      hash.update(chunk);
      await new Promise<void>((resolvePromise, reject) => { output.write(chunk, (error) => error ? reject(error) : resolvePromise()); });
    }
    await new Promise<void>((resolvePromise, reject) => { output.end((error?: Error | null) => error ? reject(error) : resolvePromise()); });
    if (totalBytes !== session.sizeBytes) throw new HttpError(409, 'UPLOAD_SIZE_MISMATCH', '合并文件大小与声明不一致');
    const sha256 = hash.digest('hex');
    const expected = String((request.body as { sha256?: string } | undefined)?.sha256 ?? asset.sha256 ?? '');
    if (expected && expected !== sha256) { await repository.updateUploadSession(session.id, { status: 'upload_failed' }); throw new HttpError(409, 'UPLOAD_CHECKSUM_MISMATCH', '文件校验和不匹配'); }
    await repository.updateUploadSession(session.id, { status: 'uploaded', sha256 });
    await rm(resolve(config.artifactRoot, 'upload-sessions', session.id), { recursive: true, force: true });
    await repository.writeAudit({ actorId: (request as AuthenticatedRequest).currentUser.id, action: 'asset.upload.complete', entityType: 'source_asset', entityId: asset.id, metadata: { sha256, sizeBytes: totalBytes } });
    return reply.status(200).send({ ...(await repository.listDatasetAssets(session.datasetId)).find((item) => item.id === asset.id), sha256 });
  });
  app.delete('/api/v1/upload-sessions/:sessionId', { preHandler: requireRoles('admin') }, async (request, reply) => {
    const session = await repository.getUploadSession(getId(request, 'sessionId'));
    if (!session) throw new HttpError(404, 'UPLOAD_SESSION_NOT_FOUND', '上传会话不存在');
    await repository.cancelUploadSession(session.id);
    await rm(resolve(config.artifactRoot, 'upload-sessions', session.id), { recursive: true, force: true });
    await repository.writeAudit({ actorId: (request as AuthenticatedRequest).currentUser.id, action: 'asset.upload.cancel', entityType: 'source_asset', entityId: session.assetId });
    return reply.status(204).send();
  });
  app.patch('/api/v1/datasets/:datasetId/classes', { preHandler: requireRoles('admin') }, async (request) => {
    const datasetId = getId(request, 'datasetId');
    const task = await repository.getAnnotationTask(datasetId);
    if (task && ['processing', 'annotating', 'reviewing', 'paused'].includes(task.status)) throw new HttpError(409, 'LABEL_SCHEMA_FROZEN', '标注任务进行中，标签和属性模板已冻结');
    const dataset = await repository.updateDatasetClasses(datasetId, parseBody(datasetClassesSchema, request.body).classes);
    if (!dataset) throw new HttpError(404, 'DATASET_NOT_FOUND', '数据集不存在');
    await repository.writeAudit({ actorId: (request as AuthenticatedRequest).currentUser.id, action: 'dataset.classes.update', entityType: 'dataset', entityId: dataset.id, metadata: { classes: dataset.classes } });
    return dataset;
  });
  app.patch('/api/v1/datasets/:datasetId/labels', { preHandler: requireRoles('admin') }, async (request) => {
    const datasetId = getId(request, 'datasetId');
    const task = await repository.getAnnotationTask(datasetId);
    if (task && ['processing', 'annotating', 'reviewing', 'paused'].includes(task.status)) throw new HttpError(409, 'LABEL_SCHEMA_FROZEN', '标注任务进行中，标签和属性模板已冻结');
    const dataset = await repository.updateDatasetLabels(datasetId, parseBody(datasetLabelsSchema, request.body).labels);
    if (!dataset) throw new HttpError(404, 'DATASET_NOT_FOUND', '数据集不存在');
    await repository.writeAudit({ actorId: (request as AuthenticatedRequest).currentUser.id, action: 'dataset.labels.update', entityType: 'dataset', entityId: dataset.id, metadata: { labels: dataset.labels ?? [] } });
    return dataset;
  });
  app.delete('/api/v1/datasets/:datasetId', { preHandler: requireRoles('admin') }, async (request, reply) => {
    const datasetId = getId(request, 'datasetId');
    if (String(request.headers['x-confirm-resource-id'] ?? '') !== datasetId) throw new HttpError(400, 'DELETE_CONFIRMATION_REQUIRED', '删除数据集前必须确认影响范围');
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
  app.get('/api/v1/datasets/:datasetId/deletion-preview', { preHandler: requireRoles('admin', 'reviewer') }, async (request) => {
    const preview = await repository.getDatasetDeletionPreview(getId(request, 'datasetId'));
    if (!preview) throw new HttpError(404, 'DATASET_NOT_FOUND', '数据集不存在');
    return preview;
  });
  app.get('/api/v1/datasets/:datasetId/images', { preHandler: requireRoles('admin', 'reviewer', 'annotator') }, async (request) => {
    const datasetId = getId(request, 'datasetId');
    const user = (request as AuthenticatedRequest).currentUser;
    await assertDatasetAccess(datasetId, user);
    const images = await repository.listDatasetImages(datasetId);
    const roles = effectiveUserRoles(user);
    if (roles.includes('admin') || roles.includes('reviewer')) return { items: images };
    const allowedImageIds = await annotatorImageIds(datasetId, user.id);
    return { items: images.filter((image) => allowedImageIds.has(image.id)) };
  });
  app.put('/api/v1/datasets/:datasetId/images', { preHandler: requireRoles('admin') }, async (request, reply) => {
    const datasetId = getId(request, 'datasetId');
    if (!await repository.getDataset(datasetId)) throw new HttpError(404, 'DATASET_NOT_FOUND', '数据集不存在');
    if (!Buffer.isBuffer(request.body) || request.body.length === 0) throw new HttpError(400, 'INVALID_IMAGE', '请上传非空图像文件');
    const settings = await repository.getSettings();
    if (request.body.length > settings.uploadMaxBytes) throw new HttpError(413, 'IMAGE_TOO_LARGE', '图像超过系统上传大小限制');
    const mimeType = String(request.headers['x-file-mime-type'] ?? '');
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)) throw new HttpError(400, 'INVALID_IMAGE', '仅支持 JPEG、PNG 或 WebP 图像');
    let decodedFilename = '';
    try { decodedFilename = decodeURIComponent(String(request.headers['x-file-name'] ?? 'image')); } catch { throw new HttpError(400, 'INVALID_IMAGE', '图像文件名编码不合法'); }
    const filename = basename(decodedFilename);
    if (!filename || filename === '.' || filename === '..') throw new HttpError(400, 'INVALID_IMAGE', '图像文件名不合法');
    const splitHeader = String(request.headers['x-image-split'] ?? 'train');
    if (!['train', 'validation', 'test'].includes(splitHeader)) throw new HttpError(400, 'VALIDATION_ERROR', '数据划分不合法');
    let dimensions: ReturnType<typeof imageSize>;
    try { dimensions = imageSize(request.body); } catch { throw new HttpError(400, 'INVALID_IMAGE', '图像文件无法解析'); }
    if (!dimensions.width || !dimensions.height) throw new HttpError(400, 'INVALID_IMAGE', '图像缺少有效尺寸');
    const objectKey = `datasets/${datasetId}/${randomUUID()}-${filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const root = resolve(config.artifactRoot);
    const filePath = resolve(root, objectKey);
    if (!filePath.startsWith(`${root}${sep}`)) throw new HttpError(400, 'INVALID_IMAGE', '图像文件路径不合法');
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, request.body);
    try {
      const sha256 = createHash('sha256').update(request.body).digest('hex');
      const asset = await repository.createSourceAsset({ datasetId, type: 'image', filename, mimeType, sizeBytes: request.body.length, sha256, objectKey });
      await repository.markSourceAssetUploaded(asset.id, sha256);
      const image = await repository.createDatasetImage({ datasetId, filename, mimeType, sizeBytes: request.body.length, objectKey, split: splitHeader as 'train' | 'validation' | 'test', width: dimensions.width, height: dimensions.height });
      await repository.writeAudit({ actorId: (request as AuthenticatedRequest).currentUser.id, action: 'dataset.image.upload', entityType: 'dataset_image', entityId: image.id, metadata: { datasetId, filename, sizeBytes: image.sizeBytes } });
      return reply.status(201).send(image);
    } catch (error) {
      await unlink(filePath).catch(() => undefined);
      throw error;
    }
  });
  app.get('/api/v1/datasets/:datasetId/images/:imageId/content', { preHandler: requireRoles('admin', 'reviewer', 'annotator') }, async (request, reply) => {
    const datasetId = getId(request, 'datasetId');
    const imageId = getId(request, 'imageId');
    await assertAnnotatorImageAccess(datasetId, imageId, (request as AuthenticatedRequest).currentUser);
    const image = await repository.getDatasetImage(datasetId, imageId);
    if (!image) throw new HttpError(404, 'DATASET_IMAGE_NOT_FOUND', '数据集图像不存在');
    const root = resolve(config.artifactRoot);
    const filePath = resolve(root, image.objectKey);
    if (!filePath.startsWith(`${root}${sep}`)) throw new HttpError(400, 'INVALID_IMAGE_PATH', '图像文件路径不合法');
    try { await stat(filePath); } catch { throw new HttpError(404, 'DATASET_IMAGE_CONTENT_NOT_FOUND', '图像文件暂不可用'); }
    return reply.type(image.mimeType).header('content-disposition', `inline; filename*=UTF-8''${encodeURIComponent(image.filename)}`).send(createReadStream(filePath));
  });
  app.get('/api/v1/datasets/:datasetId/images/:imageId/annotations', { preHandler: requireRoles('admin', 'reviewer', 'annotator') }, async (request) => {
    const datasetId = getId(request, 'datasetId');
    await assertDatasetAccess(datasetId, (request as AuthenticatedRequest).currentUser);
    await assertAnnotatorImageAccess(datasetId, getId(request, 'imageId'), (request as AuthenticatedRequest).currentUser);
    return repository.getAnnotations(datasetId, getId(request, 'imageId'));
  });
  app.put('/api/v1/datasets/:datasetId/images/:imageId/annotations', { preHandler: requireRoles('admin', 'reviewer', 'annotator') }, async (request) => {
    const datasetId = getId(request, 'datasetId');
    if (!await repository.getDataset(datasetId)) throw new HttpError(404, 'DATASET_NOT_FOUND', '数据集不存在');
    const input = parseBody(annotationSaveSchema, request.body);
    const user = (request as AuthenticatedRequest).currentUser;
    await assertAnnotatorImageAccess(datasetId, getId(request, 'imageId'), user);
    const document = await repository.saveAnnotations({ datasetId, imageId: getId(request, 'imageId'), ...input, updatedBy: user.id, updatedByRole: user.role });
    await repository.writeAudit({ actorId: user.id, action: 'annotation.save', entityType: 'annotation_document', entityId: `${datasetId}:${document.imageId}`, metadata: { revision: document.revision, count: document.annotations.length } });
    return document;
  });
  app.get('/api/v1/datasets/:datasetId/reviews', { preHandler: requireRoles('admin', 'reviewer', 'annotator') }, async (request) => {
    const datasetId = getId(request, 'datasetId');
    await assertDatasetAccess(datasetId, (request as AuthenticatedRequest).currentUser);
    return repository.getAnnotationReviewSummary(datasetId);
  });
  app.post('/api/v1/datasets/:datasetId/reviews/submit', { preHandler: requireRoles('admin', 'reviewer') }, async (request) => {
    const datasetId = getId(request, 'datasetId');
    if (!await repository.getDataset(datasetId)) throw new HttpError(404, 'DATASET_NOT_FOUND', '数据集不存在');
    const user = (request as AuthenticatedRequest).currentUser;
    const summary = await repository.submitAnnotationReview(datasetId, user.id);
    await repository.writeAudit({ actorId: user.id, action: 'annotation.review.submit', entityType: 'dataset', entityId: datasetId, metadata: { submitted: summary.submitted, approved: summary.approved } });
    return summary;
  });
  app.post('/api/v1/datasets/:datasetId/reviews/decision', { preHandler: requireRoles('admin', 'reviewer') }, async (request) => {
    const datasetId = getId(request, 'datasetId');
    if (!await repository.getDataset(datasetId)) throw new HttpError(404, 'DATASET_NOT_FOUND', '数据集不存在');
    const input = parseBody(annotationReviewDecisionSchema, request.body);
    const user = (request as AuthenticatedRequest).currentUser;
    const summary = await repository.decideAnnotationReview(datasetId, { ...input, reviewedBy: user.id });
    await repository.writeAudit({ actorId: user.id, action: `annotation.review.${input.decision}`, entityType: 'dataset', entityId: datasetId, metadata: { imageIds: input.imageIds, comment: input.comment } });
    return summary;
  });
  app.post('/api/v1/datasets/:datasetId/exports', { preHandler: requireRoles('admin', 'reviewer') }, async (request, reply) => {
    const datasetId = getId(request, 'datasetId');
    const dataset = await repository.getDataset(datasetId);
    if (!dataset) throw new HttpError(404, 'DATASET_NOT_FOUND', '数据集不存在');
    const input = parseBody(exportRequestSchema, request.body);
    const user = (request as AuthenticatedRequest).currentUser;
    const task = await repository.createExport({ datasetId, format: input.format, scope: 'all', versionName: input.versionName, includeImages: input.includeImages, createdBy: user.id });
    await queue.enqueue('export', task.id, 'cpu');
    await repository.writeAudit({ actorId: user.id, action: 'dataset.export.create', entityType: 'export_task', entityId: task.id, metadata: { datasetId, format: task.format } });
    return reply.status(202).send(task);
  });
  app.post('/api/v1/datasets/:datasetId/imports/cvat/validate', { preHandler: requireRoles('admin', 'reviewer') }, async (request) => {
    const dataset = await repository.getDataset(getId(request, 'datasetId'));
    if (!dataset) throw new HttpError(404, 'DATASET_NOT_FOUND', '数据集不存在');
    const body = request.body as { payload?: unknown; labelMapping?: Record<string, string> };
    const result = validateCvatPayload(body?.payload, dataset.classes, body?.labelMapping ?? {});
    if (!result.valid) throw new HttpError(422, 'CVAT_IMPORT_INVALID', `CVAT 导入校验失败：${result.errors.map((error) => `${error.path} ${error.message}`).join('；')}`);
    return result;
  });
  app.post('/api/v1/datasets/:datasetId/imports/cvat', { preHandler: requireRoles('admin', 'reviewer') }, async (request) => {
    const datasetId = getId(request, 'datasetId');
    const dataset = await repository.getDataset(datasetId);
    if (!dataset) throw new HttpError(404, 'DATASET_NOT_FOUND', '数据集不存在');
    const body = request.body as { payload?: unknown; xml?: string; labelMapping?: Record<string, string> };
    const payload = body?.xml ? parseCvatXml(body.xml) : body?.payload;
    const images = await repository.listDatasetImages(datasetId);
    const result = convertCvatPayload(payload, images, dataset.classes, body?.labelMapping ?? {});
    if (!result.validation.valid) throw new HttpError(422, 'CVAT_IMPORT_INVALID', `CVAT 导入校验失败：${result.validation.errors.map((error) => `${error.path} ${error.message}`).join('；')}`);
    const user = (request as AuthenticatedRequest).currentUser;
    let imported = 0;
    for (const document of result.documents) {
      const current = await repository.getAnnotations(datasetId, document.imageId);
      await repository.saveAnnotations({ datasetId, imageId: document.imageId, revision: current?.revision ?? 0, annotations: document.annotations, captions: current?.captions, imageAttributes: current?.imageAttributes, updatedBy: user.id, updatedByRole: user.role });
      imported += 1;
    }
    await repository.writeAudit({ actorId: user.id, action: 'dataset.cvat_import', entityType: 'dataset', entityId: datasetId, metadata: { imported, labels: result.validation.labels } });
    return { imported, skipped: result.documents.length - imported, labels: result.validation.labels };
  });
  app.get('/api/v1/datasets/:datasetId/exports', { preHandler: requireRoles('admin', 'reviewer') }, async (request) => {
    const datasetId = getId(request, 'datasetId');
    if (!await repository.getDataset(datasetId)) throw new HttpError(404, 'DATASET_NOT_FOUND', '数据集不存在');
    return { items: await repository.listExports(datasetId) };
  });
  app.get('/api/v1/exports/:exportId', { preHandler: requireRoles('admin', 'reviewer') }, async (request) => {
    const task = await repository.getExport(getId(request, 'exportId'));
    if (!task) throw new HttpError(404, 'EXPORT_NOT_FOUND', '导出任务不存在');
    return task;
  });
  app.get('/api/v1/artifacts/:artifactId/download', { preHandler: requireRoles('admin', 'reviewer') }, async (request, reply) => sendArtifactDownload(getId(request, 'artifactId'), reply));
  app.get('/api/v1/artifacts/:artifactId', { preHandler: requireRoles('admin', 'reviewer') }, async (request) => {
    const artifact = await repository.getArtifact(getId(request, 'artifactId'));
    if (!artifact) throw new HttpError(404, 'ARTIFACT_NOT_FOUND', '产物不存在');
    return artifact;
  });

  app.get('/api/v1/training/jobs', { preHandler: requireRoles('admin', 'reviewer') }, async () => ({ items: await repository.listTrainingJobs() }));
  app.get('/api/v1/training/jobs/:jobId', { preHandler: requireRoles('admin', 'reviewer') }, async (request) => {
    const job = await repository.getTrainingJob(getId(request, 'jobId'));
    if (!job) throw new HttpError(404, 'TRAINING_JOB_NOT_FOUND', '训练任务不存在');
    return job;
  });
  app.get('/api/v1/training/jobs/:jobId/events', { preHandler: requireRoles('admin', 'reviewer') }, async (request) => {
    const jobId = getId(request, 'jobId');
    if (!await repository.getTrainingJob(jobId)) throw new HttpError(404, 'TRAINING_JOB_NOT_FOUND', '训练任务不存在');
    return { items: await repository.listTrainingEvents(jobId) };
  });
  app.get('/api/v1/training/jobs/:jobId/observability', { preHandler: requireRoles('admin', 'reviewer') }, async (request) => {
    const jobId = getId(request, 'jobId');
    if (!await repository.getTrainingJob(jobId)) throw new HttpError(404, 'TRAINING_JOB_NOT_FOUND', '训练任务不存在');
    return repository.getTrainingObservability(jobId);
  });
  app.post('/api/v1/training/jobs', { preHandler: requireRoles('admin', 'reviewer') }, async (request, reply) => {
    const draft = parseBody(trainingDraftSchema, request.body) as TrainingDraft;
    const user = (request as AuthenticatedRequest).currentUser;
    const { job, dataset, executionTarget } = await enqueueTrainingJob(draft, user);
    await repository.writeAudit({ actorId: user.id, action: 'training.create', entityType: 'training_job', entityId: job.id, metadata: { model: job.model, version: draft.version, datasetId: dataset.id, executionTarget } });
    return reply.status(202).send(job);
  });
  app.post('/api/v1/training/jobs/:jobId/retry', { preHandler: requireRoles('admin', 'reviewer') }, async (request, reply) => {
    const sourceJobId = getId(request, 'jobId');
    const sourceJob = await repository.getTrainingJob(sourceJobId);
    if (!sourceJob) throw new HttpError(404, 'TRAINING_JOB_NOT_FOUND', '训练任务不存在');
    if (sourceJob.status !== 'failed') throw new HttpError(409, 'TRAINING_RETRY_NOT_ALLOWED', '只有失败的训练任务可以重新训练');
    const parsedConfig = trainingDraftSchema.safeParse(sourceJob.config);
    if (!parsedConfig.success) throw new HttpError(409, 'TRAINING_CONFIG_UNAVAILABLE', '该历史任务没有保存完整训练配置，请新建训练任务');
    const retryName = sourceJob.name.endsWith('（重试）') ? sourceJob.name : `${sourceJob.name.slice(0, 116)}（重试）`;
    const user = (request as AuthenticatedRequest).currentUser;
    const { job, dataset, executionTarget } = await enqueueTrainingJob({ ...parsedConfig.data, name: retryName } as TrainingDraft, user, sourceJobId, sourceJob.snapshotId);
    await repository.writeAudit({ actorId: user.id, action: 'training.retry', entityType: 'training_job', entityId: job.id, metadata: { sourceJobId, model: job.model, datasetId: dataset.id, executionTarget } });
    return reply.status(202).send(job);
  });
  app.post('/api/v1/training/jobs/:jobId/cancel', { preHandler: requireRoles('admin', 'reviewer') }, async (request) => {
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
  app.delete('/api/v1/training/jobs/:jobId', { preHandler: requireRoles('admin', 'reviewer') }, async (request, reply) => {
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

  app.get('/api/v1/models', { preHandler: requireRoles('admin', 'reviewer') }, async () => ({ items: await repository.listModels() }));
  app.get('/api/v1/models/:modelId', { preHandler: requireRoles('admin', 'reviewer') }, async (request) => {
    const model = await repository.getModel(getId(request, 'modelId'));
    if (!model) throw new HttpError(404, 'MODEL_NOT_FOUND', '模型版本不存在');
    return model;
  });
  app.put('/api/v1/models/upload', { preHandler: requireRoles('admin', 'reviewer') }, async (request, reply) => {
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
  app.patch('/api/v1/models/:modelId/stage', { preHandler: requireRoles('admin', 'reviewer') }, async (request) => {
    const model = await repository.updateModelStage(getId(request, 'modelId'), parseBody(modelStageSchema, request.body).stage);
    if (!model) throw new HttpError(404, 'MODEL_NOT_FOUND', '模型版本不存在');
    await repository.writeAudit({ actorId: (request as AuthenticatedRequest).currentUser.id, action: 'model.stage.update', entityType: 'model_version', entityId: model.id, metadata: { stage: model.stage } });
    return model;
  });
  app.delete('/api/v1/models/:modelId', { preHandler: requireRoles('admin', 'reviewer') }, async (request, reply) => {
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
  app.get('/api/v1/conversions', { preHandler: requireRoles('admin', 'reviewer') }, async () => ({ items: await repository.listConversions() }));
  app.get('/api/v1/conversions/:conversionId', { preHandler: requireRoles('admin', 'reviewer') }, async (request) => {
    const task = await repository.getConversion(getId(request, 'conversionId'));
    if (!task) throw new HttpError(404, 'CONVERSION_NOT_FOUND', '转换任务不存在');
    return task;
  });
  app.post('/api/v1/conversions', { preHandler: requireRoles('admin', 'reviewer') }, async (request, reply) => {
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
  app.post('/api/v1/conversions/:conversionId/cancel', { preHandler: requireRoles('admin', 'reviewer') }, async (request) => {
    const task = await repository.cancelConversion(getId(request, 'conversionId'));
    if (!task) throw new HttpError(404, 'CONVERSION_NOT_FOUND', '转换任务不存在');
    await repository.writeAudit({ actorId: (request as AuthenticatedRequest).currentUser.id, action: 'conversion.cancel', entityType: 'conversion_job', entityId: task.id });
    return task;
  });
  app.delete('/api/v1/conversions/:conversionId', { preHandler: requireRoles('admin', 'reviewer') }, async (request, reply) => {
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
