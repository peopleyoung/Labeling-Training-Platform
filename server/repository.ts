import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Pool, type PoolClient } from 'pg';
import type { AnnotationReviewDecisionInput, AnnotationReviewItem, AnnotationReviewSummary, Artifact, AuthUser, AnnotationDocument, ConversionTask, Dataset, DatasetImage, ExportTask, ModelVersion, TrainingDraft, TrainingEvent, TrainingJob, TrainingObservability, TrainingMetricPoint, TrainingResourceSample, UserRole, WorkspaceActivity } from '../shared/contracts';
import { RepositoryConflictError, RepositoryStateError } from './errors';
import { workspaceId } from './workspace';

export interface StoredUser extends AuthUser {
  passwordHash: string;
}

export interface MemoryRepositoryFixtures {
  users?: Array<AuthUser & { password: string }>;
  datasets?: Dataset[];
  jobs?: TrainingJob[];
  models?: ModelVersion[];
  conversions?: ConversionTask[];
}

export interface DatasetDeletionPlan {
  dataset: Dataset;
  exports: ExportTask[];
}

export interface TrainingDeletionPlan {
  job: TrainingJob;
  models: ModelVersion[];
  conversions: ConversionTask[];
}

export interface ModelDeletionPlan {
  model: ModelVersion;
  conversions: ConversionTask[];
}

export interface Repository {
  close(): Promise<void>;
  findUserByUsername(username: string): Promise<StoredUser | null>;
  findUserById(id: string): Promise<StoredUser | null>;
  listDatasets(): Promise<Dataset[]>;
  getDataset(id: string): Promise<Dataset | null>;
  createDataset(input: { name: string; description: string; version: string; classes: string[] }): Promise<Dataset>;
  updateDatasetClasses(id: string, classes: string[]): Promise<Dataset | null>;
  getDatasetDeletionPlan(id: string): Promise<DatasetDeletionPlan | null>;
  deleteDataset(id: string): Promise<boolean>;
  listDatasetArtifacts(datasetId: string): Promise<Artifact[]>;
  listDatasetImages(datasetId: string): Promise<DatasetImage[]>;
  getDatasetImage(datasetId: string, imageId: string): Promise<DatasetImage & { objectKey: string } | null>;
  createDatasetImage(input: { datasetId: string; filename: string; mimeType: string; sizeBytes: number; objectKey: string; split: DatasetImage['split']; width?: number; height?: number }): Promise<DatasetImage>;
  getAnnotations(datasetId: string, imageId: string): Promise<AnnotationDocument | null>;
  saveAnnotations(input: { datasetId: string; imageId: string; revision: number; annotations: AnnotationDocument['annotations']; captions?: AnnotationDocument['captions']; imageAttributes?: AnnotationDocument['imageAttributes']; updatedBy: string }): Promise<AnnotationDocument>;
  getAnnotationReviewSummary(datasetId: string): Promise<AnnotationReviewSummary>;
  submitAnnotationReview(datasetId: string, submittedBy: string): Promise<AnnotationReviewSummary>;
  decideAnnotationReview(datasetId: string, input: AnnotationReviewDecisionInput & { reviewedBy: string }): Promise<AnnotationReviewSummary>;
  listTrainingJobs(): Promise<TrainingJob[]>;
  getTrainingJob(id: string): Promise<TrainingJob | null>;
  listTrainingEvents(jobId: string): Promise<TrainingEvent[]>;
  getTrainingObservability(jobId: string): Promise<TrainingObservability>;
  createTrainingJob(input: { draft: TrainingDraft; datasetName: string; createdBy: string; retrySourceId?: string }): Promise<TrainingJob>;
  cancelTrainingJob(id: string): Promise<TrainingJob | null>;
  getTrainingDeletionPlan(id: string): Promise<TrainingDeletionPlan | null>;
  deleteTrainingJob(id: string): Promise<boolean>;
  listModels(): Promise<ModelVersion[]>;
  getModel(id: string): Promise<ModelVersion | null>;
  getModelByNameVersion(name: string, version: string): Promise<ModelVersion | null>;
  createUploadedModel(input: { id: string; artifactId: string; name: string; version: string; task: ModelVersion['task']; framework: string; stage: ModelVersion['stage']; objectKey: string; filename: string; mimeType: string; sizeBytes: number; sha256: string; createdBy: string }): Promise<ModelVersion>;
  updateModelStage(id: string, stage: ModelVersion['stage']): Promise<ModelVersion | null>;
  getModelDeletionPlan(id: string): Promise<ModelDeletionPlan | null>;
  deleteModel(id: string): Promise<boolean>;
  listConversions(): Promise<ConversionTask[]>;
  getConversion(id: string): Promise<ConversionTask | null>;
  createConversion(input: { modelName: string; modelVersion: string; format: ConversionTask['format']; precision: string; target: string; options: Record<string, string | boolean>; createdBy: string }): Promise<ConversionTask>;
  cancelConversion(id: string): Promise<ConversionTask | null>;
  deleteConversion(id: string): Promise<boolean>;
  createExport(input: { datasetId: string; format: ExportTask['format']; scope: NonNullable<ExportTask['scope']>; versionName: string; includeImages: boolean; createdBy: string }): Promise<ExportTask>;
  listExports(datasetId: string): Promise<ExportTask[]>;
  getExport(id: string): Promise<ExportTask | null>;
  getArtifact(id: string): Promise<Artifact | null>;
  listRecentActivities(limit: number): Promise<WorkspaceActivity[]>;
  writeAudit(input: { actorId: string; action: string; entityType: string; entityId?: string; metadata?: Record<string, unknown> }): Promise<void>;
}

function displayDate(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function formatBytes(value: number) {
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}

const emptyImageAttributes: AnnotationDocument['imageAttributes'] = { includeInSdxl: false, tags: [] };

function annotationDocumentHasContent(document: Pick<AnnotationDocument, 'annotations' | 'captions' | 'imageAttributes'>) {
  return document.annotations.length > 0 || document.captions.length > 0 || document.imageAttributes.tags.length > 0;
}

function newTrainingJob(input: { draft: TrainingDraft; datasetName: string; createdBy: string }): TrainingJob {
  const metric = input.draft.type === 'segmentation' ? ['mIoU', '--'] : input.draft.type === 'keypoint' ? ['OKS', '--'] : input.draft.type === 'sdxl' ? ['Loss', '--'] : ['mAP@50', '--'];
  return {
    id: `train-${randomUUID()}`,
    name: input.draft.name,
    type: input.draft.type,
    model: input.draft.model,
    dataset: input.datasetName,
    status: 'queued',
    progress: 0,
    epoch: `0 / ${input.draft.epochs}`,
    metricName: metric[0],
    metricValue: metric[1],
    gpu: input.draft.gpu,
    createdAt: new Date().toISOString(),
    eta: '正在分配资源',
    createdBy: input.createdBy,
  };
}

export class MemoryRepository implements Repository {
  private readonly users: StoredUser[];
  private readonly datasets: Dataset[];
  private readonly jobs: TrainingJob[];
  private readonly models: ModelVersion[];
  private readonly conversions: ConversionTask[];
  private readonly datasetImages = new Map<string, Array<DatasetImage & { objectKey: string }>>();
  private readonly annotations = new Map<string, AnnotationDocument>();
  private readonly exports: ExportTask[] = [];
  private readonly artifacts = new Map<string, Artifact>();
  private readonly trainingEvents: TrainingEvent[] = [];
  private readonly trainingMetrics: TrainingMetricPoint[] = [];
  private readonly trainingResources: TrainingResourceSample[] = [];
  private readonly auditLogs: WorkspaceActivity[] = [];

  constructor(fixtures: MemoryRepositoryFixtures = {}) {
    this.users = (fixtures.users ?? []).map((user) => ({ ...user, passwordHash: bcrypt.hashSync(user.password, 10) }));
    this.datasets = structuredClone(fixtures.datasets ?? []);
    this.jobs = structuredClone(fixtures.jobs ?? []);
    this.models = structuredClone(fixtures.models ?? []);
    this.conversions = structuredClone(fixtures.conversions ?? []);
  }

  async close() {}

  async findUserByUsername(username: string) { return this.users.find((user) => user.username === username) ?? null; }
  async findUserById(id: string) { return this.users.find((user) => user.id === id) ?? null; }
  async listDatasets() { return structuredClone(this.datasets); }
  async getDataset(id: string) { return structuredClone(this.datasets.find((dataset) => dataset.id === id) ?? null); }
  async createDataset(input: { name: string; description: string; version: string; classes: string[] }) {
    const dataset: Dataset = { id: `dataset-${randomUUID()}`, ...input, images: 0, annotated: 0, size: '0 B', status: '标注中', updatedAt: new Date().toISOString() };
    this.datasets.unshift(dataset);
    return structuredClone(dataset);
  }
  async updateDatasetClasses(id: string, classes: string[]) {
    const dataset = this.datasets.find((item) => item.id === id);
    if (!dataset) return null;
    dataset.classes = [...new Set(classes)];
    dataset.updatedAt = new Date().toISOString();
    return structuredClone(dataset);
  }
  async getDatasetDeletionPlan(id: string) {
    const dataset = this.datasets.find((item) => item.id === id);
    if (!dataset) return null;
    return structuredClone({ dataset, exports: this.exports.filter((task) => task.datasetId === id) });
  }
  async deleteDataset(id: string) {
    const index = this.datasets.findIndex((item) => item.id === id);
    if (index < 0) return false;
    this.datasets.splice(index, 1);
    this.datasetImages.delete(id);
    for (const key of this.annotations.keys()) if (key.startsWith(`${id}:`)) this.annotations.delete(key);
    const exportIds = this.exports.filter((task) => task.datasetId === id).map((task) => task.id);
    for (let index = this.exports.length - 1; index >= 0; index -= 1) if (this.exports[index].datasetId === id) this.exports.splice(index, 1);
    for (const [artifactId, artifact] of this.artifacts) if (artifact.sourceType === 'export_task' && exportIds.includes(artifact.sourceId)) this.artifacts.delete(artifactId);
    return true;
  }
  async listDatasetArtifacts(datasetId: string) { const exportIds = this.exports.filter((task) => task.datasetId === datasetId).map((task) => task.id); return structuredClone([...this.artifacts.values()].filter((artifact) => artifact.sourceType === 'export_task' && exportIds.includes(artifact.sourceId))); }
  async listDatasetImages(datasetId: string) { return structuredClone(this.datasetImages.get(datasetId) ?? []).map(({ objectKey: _, ...image }) => image); }
  async getDatasetImage(datasetId: string, imageId: string) { return structuredClone(this.datasetImages.get(datasetId)?.find((image) => image.id === imageId) ?? null); }
  async createDatasetImage(input: { datasetId: string; filename: string; mimeType: string; sizeBytes: number; objectKey: string; split: DatasetImage['split']; width?: number; height?: number }) {
    const dataset = this.datasets.find((item) => item.id === input.datasetId);
    if (!dataset) throw new Error('Dataset not found');
    const image: DatasetImage & { objectKey: string } = { id: `image-${randomUUID()}`, ...input, createdAt: new Date().toISOString() };
    const images = this.datasetImages.get(input.datasetId) ?? [];
    images.push(image);
    this.datasetImages.set(input.datasetId, images);
    dataset.images = images.length;
    dataset.size = formatBytes(images.reduce((total, item) => total + item.sizeBytes, 0));
    dataset.status = '标注中';
    dataset.updatedAt = new Date().toISOString();
    const { objectKey: _, ...publicImage } = image;
    return structuredClone(publicImage);
  }

  async getAnnotations(datasetId: string, imageId: string) {
    return structuredClone(this.annotations.get(`${datasetId}:${imageId}`) ?? { datasetId, imageId, revision: 0, annotations: [], captions: [], imageAttributes: emptyImageAttributes, updatedAt: new Date(0).toISOString(), updatedBy: '', reviewStatus: 'draft' as const });
  }

  private refreshDatasetReviewState(datasetId: string) {
    const dataset = this.datasets.find((item) => item.id === datasetId);
    if (!dataset) return;
    const imageIds = new Set((this.datasetImages.get(datasetId) ?? []).map((image) => image.id));
    const documents = [...this.annotations.values()].filter((document) => document.datasetId === datasetId && imageIds.has(document.imageId));
    dataset.annotated = documents.filter(annotationDocumentHasContent).length;
    const approved = documents.filter((document) => document.reviewStatus === 'approved').length;
    const submitted = documents.some((document) => document.reviewStatus === 'submitted');
    dataset.status = dataset.images > 0 && approved === dataset.images ? '可训练' : submitted ? '待审核' : '标注中';
    dataset.updatedAt = new Date().toISOString();
  }

  private buildAnnotationReviewSummary(datasetId: string): AnnotationReviewSummary {
    const dataset = this.datasets.find((item) => item.id === datasetId);
    if (!dataset) throw new RepositoryStateError('DATASET_NOT_FOUND', '数据集不存在');
    const items: AnnotationReviewItem[] = (this.datasetImages.get(datasetId) ?? []).map((image) => {
      const document = this.annotations.get(`${datasetId}:${image.id}`);
      return {
        imageId: image.id,
        filename: image.filename,
        revision: document?.revision ?? 0,
        annotationCount: document ? document.annotations.length + document.captions.length + document.imageAttributes.tags.length : 0,
        reviewStatus: document?.reviewStatus ?? 'draft',
        submittedAt: document?.submittedAt,
        submittedBy: document?.submittedBy,
        reviewedAt: document?.reviewedAt,
        reviewedBy: document?.reviewedBy,
        reviewComment: document?.reviewComment,
      };
    });
    return {
      datasetId,
      datasetStatus: dataset.status,
      total: items.length,
      draft: items.filter((item) => item.reviewStatus === 'draft').length,
      submitted: items.filter((item) => item.reviewStatus === 'submitted').length,
      approved: items.filter((item) => item.reviewStatus === 'approved').length,
      rejected: items.filter((item) => item.reviewStatus === 'rejected').length,
      items,
    };
  }

  async saveAnnotations(input: { datasetId: string; imageId: string; revision: number; annotations: AnnotationDocument['annotations']; captions?: AnnotationDocument['captions']; imageAttributes?: AnnotationDocument['imageAttributes']; updatedBy: string }) {
    const key = `${input.datasetId}:${input.imageId}`;
    const current = this.annotations.get(key);
    if ((current?.revision ?? 0) !== input.revision) throw new RepositoryConflictError();
    if (current?.reviewStatus === 'submitted') throw new RepositoryStateError('ANNOTATION_REVIEW_LOCKED', '标注已提交审核，审核完成前不能修改');
    const captions = structuredClone(input.captions ?? current?.captions ?? []);
    const imageAttributes = structuredClone(input.imageAttributes ?? current?.imageAttributes ?? emptyImageAttributes);
    if (imageAttributes.includeInSdxl && !captions.some((caption) => caption.primary && caption.text.trim())) throw new RepositoryStateError('SDXL_CAPTION_REQUIRED', '纳入 SDXL 训练的图片必须填写主 Caption');
    const document: AnnotationDocument = { datasetId: input.datasetId, imageId: input.imageId, revision: input.revision + 1, annotations: structuredClone(input.annotations), captions, imageAttributes, updatedAt: new Date().toISOString(), updatedBy: input.updatedBy, reviewStatus: 'draft' };
    this.annotations.set(key, document);
    this.refreshDatasetReviewState(input.datasetId);
    return structuredClone(document);
  }

  async getAnnotationReviewSummary(datasetId: string) {
    return structuredClone(this.buildAnnotationReviewSummary(datasetId));
  }

  async submitAnnotationReview(datasetId: string, submittedBy: string) {
    const images = this.datasetImages.get(datasetId) ?? [];
    if (images.length === 0) throw new RepositoryStateError('ANNOTATION_REVIEW_INCOMPLETE', '数据集没有可提交的图像');
    const documents = images.map((image) => this.annotations.get(`${datasetId}:${image.id}`));
    if (documents.some((document) => !document || !annotationDocumentHasContent(document))) {
      throw new RepositoryStateError('ANNOTATION_REVIEW_INCOMPLETE', '请完成全部图像标注后再提交审核');
    }
    const submittedAt = new Date().toISOString();
    for (const document of documents) {
      if (!document || document.reviewStatus === 'approved') continue;
      document.reviewStatus = 'submitted';
      document.submittedAt = submittedAt;
      document.submittedBy = submittedBy;
      delete document.reviewedAt;
      delete document.reviewedBy;
      delete document.reviewComment;
    }
    this.refreshDatasetReviewState(datasetId);
    return structuredClone(this.buildAnnotationReviewSummary(datasetId));
  }

  async decideAnnotationReview(datasetId: string, input: AnnotationReviewDecisionInput & { reviewedBy: string }) {
    const imageIds = new Set((this.datasetImages.get(datasetId) ?? []).map((image) => image.id));
    const documents = input.imageIds.map((imageId) => imageIds.has(imageId) ? this.annotations.get(`${datasetId}:${imageId}`) : undefined);
    if (documents.some((document) => !document)) throw new RepositoryStateError('ANNOTATION_REVIEW_IMAGE_NOT_FOUND', '审核图像不存在');
    if (documents.some((document) => document?.reviewStatus !== 'submitted')) throw new RepositoryStateError('ANNOTATION_REVIEW_INVALID_STATE', '只能审核处于待审核状态的图像');
    const reviewedAt = new Date().toISOString();
    for (const document of documents) {
      if (!document) continue;
      document.reviewStatus = input.decision === 'approve' ? 'approved' : 'rejected';
      document.reviewedAt = reviewedAt;
      document.reviewedBy = input.reviewedBy;
      document.reviewComment = input.comment;
    }
    this.refreshDatasetReviewState(datasetId);
    return structuredClone(this.buildAnnotationReviewSummary(datasetId));
  }

  async listTrainingJobs() { return structuredClone(this.jobs); }
  async getTrainingJob(id: string) { return structuredClone(this.jobs.find((job) => job.id === id) ?? null); }
  async listTrainingEvents(jobId: string) { return structuredClone(this.trainingEvents.filter((event) => event.jobId === jobId)); }
  async getTrainingObservability(jobId: string) { return structuredClone({ metrics: this.trainingMetrics.filter((point) => point.jobId === jobId), resources: this.trainingResources.filter((sample) => sample.jobId === jobId) }); }
  async createTrainingJob(input: { draft: TrainingDraft; datasetName: string; createdBy: string; retrySourceId?: string }) { const job = { ...newTrainingJob(input), config: structuredClone(input.draft) }; this.jobs.unshift(job); this.trainingEvents.push({ id: String(this.trainingEvents.length + 1), jobId: job.id, level: 'info', message: input.retrySourceId ? `由失败任务 ${input.retrySourceId} 重新创建并进入资源队列` : '训练任务已创建并进入资源队列', createdAt: new Date().toISOString() }); return structuredClone(job); }
  async cancelTrainingJob(id: string) { const job = this.jobs.find((item) => item.id === id); if (!job || !['queued', 'running'].includes(job.status)) return job ? structuredClone(job) : null; job.status = 'cancelled'; job.eta = '已取消'; this.trainingEvents.push({ id: String(this.trainingEvents.length + 1), jobId: id, level: 'warning', message: '训练任务已由用户取消', createdAt: new Date().toISOString() }); return structuredClone(job); }
  async getTrainingDeletionPlan(id: string) {
    const job = this.jobs.find((item) => item.id === id);
    if (!job) return null;
    const models = this.models.filter((model) => model.sourceJob === id);
    const identities = new Set(models.map((model) => `${model.name}\u0000${model.version}`));
    const conversions = this.conversions.filter((task) => identities.has(`${task.modelName}\u0000${task.modelVersion}`));
    return structuredClone({ job, models, conversions });
  }
  async deleteTrainingJob(id: string) {
    const index = this.jobs.findIndex((job) => job.id === id);
    if (index < 0) return false;
    const models = this.models.filter((model) => model.sourceJob === id);
    const identities = new Set(models.map((model) => `${model.name}\u0000${model.version}`));
    const conversionIds = this.conversions.filter((task) => identities.has(`${task.modelName}\u0000${task.modelVersion}`)).map((task) => task.id);
    for (let conversionIndex = this.conversions.length - 1; conversionIndex >= 0; conversionIndex -= 1) {
      if (conversionIds.includes(this.conversions[conversionIndex].id)) this.conversions.splice(conversionIndex, 1);
    }
    for (let modelIndex = this.models.length - 1; modelIndex >= 0; modelIndex -= 1) {
      if (this.models[modelIndex].sourceJob === id) this.models.splice(modelIndex, 1);
    }
    this.jobs.splice(index, 1);
    for (const records of [this.trainingEvents, this.trainingMetrics, this.trainingResources]) {
      for (let recordIndex = records.length - 1; recordIndex >= 0; recordIndex -= 1) {
        if (records[recordIndex].jobId === id) records.splice(recordIndex, 1);
      }
    }
    for (const [artifactId, artifact] of this.artifacts) {
      if ((artifact.sourceType === 'training_job' && artifact.sourceId === id) || (artifact.sourceType === 'conversion_job' && conversionIds.includes(artifact.sourceId))) this.artifacts.delete(artifactId);
    }
    return true;
  }
  async listModels() { return structuredClone(this.models); }
  async getModel(id: string) { return structuredClone(this.models.find((model) => model.id === id) ?? null); }
  async getModelByNameVersion(name: string, version: string) { return structuredClone(this.models.find((model) => model.name === name && model.version === version) ?? null); }
  async createUploadedModel(input: { id: string; artifactId: string; name: string; version: string; task: ModelVersion['task']; framework: string; stage: ModelVersion['stage']; objectKey: string; filename: string; mimeType: string; sizeBytes: number; sha256: string; createdBy: string }) {
    const model: ModelVersion = { id: input.id, name: input.name, version: input.version, task: input.task, sourceJob: 'manual-upload', metricName: '待评估', metricValue: '--', framework: input.framework, size: formatBytes(input.sizeBytes), createdAt: new Date().toISOString(), formats: [], stage: input.stage, artifactId: input.artifactId };
    this.models.unshift(model);
    this.artifacts.set(input.artifactId, { id: input.artifactId, objectKey: input.objectKey, filename: input.filename, mimeType: input.mimeType, sizeBytes: input.sizeBytes, sha256: input.sha256, sourceType: 'model_upload', sourceId: input.id, createdAt: model.createdAt });
    return structuredClone(model);
  }
  async updateModelStage(id: string, stage: ModelVersion['stage']) { const model = this.models.find((item) => item.id === id); if (!model) return null; model.stage = stage; return structuredClone(model); }
  async getModelDeletionPlan(id: string) {
    const model = this.models.find((item) => item.id === id);
    if (!model) return null;
    const conversions = this.conversions.filter((task) => task.modelName === model.name && task.modelVersion === model.version);
    return structuredClone({ model, conversions });
  }
  async deleteModel(id: string) {
    const index = this.models.findIndex((model) => model.id === id);
    if (index < 0) return false;
    const model = this.models[index];
    const conversionIds = this.conversions.filter((task) => task.modelName === model.name && task.modelVersion === model.version).map((task) => task.id);
    for (let conversionIndex = this.conversions.length - 1; conversionIndex >= 0; conversionIndex -= 1) {
      if (conversionIds.includes(this.conversions[conversionIndex].id)) this.conversions.splice(conversionIndex, 1);
    }
    this.models.splice(index, 1);
    for (const [artifactId, artifact] of this.artifacts) {
      if ((artifact.sourceType === 'model_upload' && artifact.sourceId === id) || (artifact.sourceType === 'conversion_job' && conversionIds.includes(artifact.sourceId)) || artifactId === model.artifactId) this.artifacts.delete(artifactId);
    }
    const sourceJob = this.jobs.find((job) => job.id === model.sourceJob);
    if (sourceJob && sourceJob.artifactId === model.artifactId) delete sourceJob.artifactId;
    return true;
  }
  async listConversions() { return structuredClone(this.conversions); }
  async getConversion(id: string) { return structuredClone(this.conversions.find((item) => item.id === id) ?? null); }
  async createConversion(input: { modelName: string; modelVersion: string; format: ConversionTask['format']; precision: string; target: string; options: Record<string, string | boolean>; createdBy: string }) { const task: ConversionTask = { id: `convert-${randomUUID()}`, ...input, status: 'queued', progress: 0, size: '计算中', createdAt: new Date().toISOString() }; this.conversions.unshift(task); return structuredClone(task); }
  async cancelConversion(id: string) { const task = this.conversions.find((item) => item.id === id); if (!task || !['queued', 'running'].includes(task.status)) return task ? structuredClone(task) : null; task.status = 'cancelled'; return structuredClone(task); }
  async deleteConversion(id: string) {
    const index = this.conversions.findIndex((task) => task.id === id);
    if (index < 0) return false;
    const task = this.conversions[index];
    this.conversions.splice(index, 1);
    for (const [artifactId, artifact] of this.artifacts) {
      if ((artifact.sourceType === 'conversion_job' && artifact.sourceId === id) || artifactId === task.artifactId) this.artifacts.delete(artifactId);
    }
    return true;
  }
  async createExport(input: { datasetId: string; format: ExportTask['format']; scope: NonNullable<ExportTask['scope']>; versionName: string; includeImages: boolean; createdBy: string }) { const task: ExportTask = { id: `export-${randomUUID()}`, ...input, status: 'queued', progress: 0, createdAt: new Date().toISOString() }; this.exports.unshift(task); return structuredClone(task); }
  async listExports(datasetId: string) { return structuredClone(this.exports.filter((task) => task.datasetId === datasetId)); }
  async getExport(id: string) { return structuredClone(this.exports.find((task) => task.id === id) ?? null); }
  async getArtifact(id: string): Promise<Artifact | null> { return structuredClone(this.artifacts.get(id) ?? null); }
  async listRecentActivities(limit: number) { return structuredClone(this.auditLogs.filter((activity) => activity.action !== 'auth.login').slice(0, limit)); }
  async writeAudit(input: { actorId: string; action: string; entityType: string; entityId?: string; metadata?: Record<string, unknown> }) {
    const actor = this.users.find((user) => user.id === input.actorId);
    this.auditLogs.unshift({
      id: `audit-${randomUUID()}`,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      metadata: structuredClone(input.metadata ?? {}),
      actor: actor ? { id: actor.id, displayName: actor.displayName } : null,
      createdAt: new Date().toISOString(),
    });
  }
}

function mapUser(row: Record<string, unknown>): StoredUser {
  return { id: String(row.id), workspaceId: String(row.workspace_id), username: String(row.username), displayName: String(row.display_name), role: row.role as UserRole, mustChangePassword: Boolean(row.must_change_password), passwordHash: String(row.password_hash) };
}

function mapDataset(row: Record<string, unknown>): Dataset {
  return { id: String(row.id), name: String(row.name), description: String(row.description), version: String(row.version), legacyType: row.type ? row.type as Dataset['legacyType'] : undefined, images: Number(row.images), annotated: Number(row.annotated), classes: (row.classes as string[]) ?? [], updatedAt: displayDate(row.updated_at as string | Date), size: String(row.size), status: row.status as Dataset['status'] };
}

function mapDatasetImage(row: Record<string, unknown>): DatasetImage & { objectKey: string } {
  return {
    id: String(row.id),
    datasetId: String(row.dataset_id),
    objectKey: String(row.object_key),
    filename: String(row.filename),
    mimeType: String(row.mime_type),
    sizeBytes: Number(row.size_bytes),
    width: row.width === null ? undefined : Number(row.width),
    height: row.height === null ? undefined : Number(row.height),
    split: row.split as DatasetImage['split'],
    createdAt: displayDate(row.created_at as string | Date),
  };
}

function optionalDate(value: unknown): string | undefined {
  return value ? displayDate(value as string | Date) : undefined;
}

function mapAnnotationDocument(row: Record<string, unknown>): AnnotationDocument {
  return {
    datasetId: String(row.dataset_id),
    imageId: String(row.image_id),
    revision: Number(row.revision),
    annotations: row.annotations as AnnotationDocument['annotations'],
    captions: (row.captions as AnnotationDocument['captions'] | undefined) ?? [],
    imageAttributes: (row.image_attributes as AnnotationDocument['imageAttributes'] | undefined) ?? emptyImageAttributes,
    updatedAt: displayDate(row.updated_at as string | Date),
    updatedBy: String(row.updated_by),
    reviewStatus: row.review_status as AnnotationDocument['reviewStatus'],
    submittedAt: optionalDate(row.submitted_at),
    submittedBy: row.submitted_by ? String(row.submitted_by) : undefined,
    reviewedAt: optionalDate(row.reviewed_at),
    reviewedBy: row.reviewed_by ? String(row.reviewed_by) : undefined,
    reviewComment: row.review_comment ? String(row.review_comment) : undefined,
  };
}

function mapAnnotationReviewItem(row: Record<string, unknown>): AnnotationReviewItem {
  return {
    imageId: String(row.image_id),
    filename: String(row.filename),
    revision: Number(row.revision ?? 0),
    annotationCount: Number(row.annotation_count ?? 0),
    reviewStatus: (row.review_status ?? 'draft') as AnnotationReviewItem['reviewStatus'],
    submittedAt: optionalDate(row.submitted_at),
    submittedBy: row.submitted_by ? String(row.submitted_by) : undefined,
    reviewedAt: optionalDate(row.reviewed_at),
    reviewedBy: row.reviewed_by ? String(row.reviewed_by) : undefined,
    reviewComment: row.review_comment ? String(row.review_comment) : undefined,
  };
}

function mapJob(row: Record<string, unknown>): TrainingJob {
  return { id: String(row.id), name: String(row.name), type: row.type as TrainingJob['type'], model: String(row.model), dataset: String(row.dataset), status: row.status as TrainingJob['status'], progress: Number(row.progress), epoch: String(row.epoch), metricName: String(row.metric_name), metricValue: String(row.metric_value), gpu: String(row.gpu), createdAt: displayDate(row.created_at as string | Date), eta: String(row.eta), createdBy: row.created_by ? String(row.created_by) : undefined, errorMessage: row.error_message ? String(row.error_message) : undefined, config: row.config as TrainingDraft | undefined, artifactId: row.artifact_id ? String(row.artifact_id) : undefined };
}

function mapConversion(row: Record<string, unknown>): ConversionTask {
  return { id: String(row.id), modelName: String(row.model_name), modelVersion: String(row.model_version), format: row.format as ConversionTask['format'], precision: String(row.precision), target: String(row.target), status: row.status as ConversionTask['status'], progress: Number(row.progress), size: String(row.size), createdAt: displayDate(row.created_at as string | Date), createdBy: row.created_by ? String(row.created_by) : undefined, errorMessage: row.error_message ? String(row.error_message) : undefined, artifactId: row.artifact_id ? String(row.artifact_id) : undefined, options: row.config as Record<string, string | boolean> | undefined };
}

function mapExport(row: Record<string, unknown>): ExportTask {
  return {
    id: String(row.id),
    datasetId: String(row.dataset_id),
    format: row.format as ExportTask['format'],
    status: row.status as ExportTask['status'],
    progress: Number(row.progress),
    artifactId: row.artifact_id ? String(row.artifact_id) : undefined,
    createdAt: displayDate(row.created_at as string | Date),
    errorMessage: row.error_message ? String(row.error_message) : undefined,
    scope: row.scope as ExportTask['scope'],
    versionName: row.version_name ? String(row.version_name) : undefined,
    includeImages: row.include_images === undefined ? undefined : Boolean(row.include_images),
  };
}

function mapArtifact(row: Record<string, unknown>): Artifact {
  return {
    id: String(row.id),
    objectKey: String(row.object_key),
    filename: String(row.filename),
    mimeType: String(row.mime_type),
    sizeBytes: Number(row.size_bytes),
    sha256: String(row.sha256),
    sourceType: String(row.source_type),
    sourceId: String(row.source_id),
    createdAt: displayDate(row.created_at as string | Date),
  };
}

function mapTrainingEvent(row: Record<string, unknown>): TrainingEvent {
  return { id: String(row.id), jobId: String(row.job_id), level: row.level as TrainingEvent['level'], message: String(row.message), createdAt: displayDate(row.created_at as string | Date) };
}

function mapWorkspaceActivity(row: Record<string, unknown>): WorkspaceActivity {
  return {
    id: String(row.id),
    action: String(row.action),
    entityType: String(row.entity_type),
    entityId: row.entity_id ? String(row.entity_id) : undefined,
    metadata: row.metadata && typeof row.metadata === 'object' ? row.metadata as Record<string, unknown> : {},
    actor: row.actor_id ? { id: String(row.actor_id), displayName: String(row.actor_name ?? row.actor_id) } : null,
    createdAt: displayDate(row.created_at as string | Date),
  };
}

function mapTrainingMetric(row: Record<string, unknown>): TrainingMetricPoint {
  return { id: String(row.id), jobId: String(row.job_id), epoch: Number(row.epoch), progress: Number(row.progress), metrics: (row.metrics as Record<string, number>) ?? {}, createdAt: displayDate(row.created_at as string | Date) };
}

function optionalNumber(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function mapTrainingResource(row: Record<string, unknown>): TrainingResourceSample {
  return {
    id: String(row.id),
    jobId: String(row.job_id),
    device: row.device as TrainingResourceSample['device'],
    cpuPercent: Number(row.cpu_percent),
    memoryUsedMb: Number(row.memory_used_mb),
    memoryTotalMb: optionalNumber(row.memory_total_mb),
    gpuPercent: optionalNumber(row.gpu_percent),
    gpuMemoryUsedMb: optionalNumber(row.gpu_memory_used_mb),
    gpuMemoryTotalMb: optionalNumber(row.gpu_memory_total_mb),
    gpuPowerWatts: optionalNumber(row.gpu_power_watts),
    createdAt: displayDate(row.created_at as string | Date),
  };
}

function mapModel(row: Record<string, unknown>): ModelVersion {
  return {
    id: String(row.id),
    name: String(row.name),
    version: String(row.version),
    task: row.task as ModelVersion['task'],
    sourceJob: String(row.source_job),
    metricName: String(row.metric_name),
    metricValue: String(row.metric_value),
    framework: String(row.framework),
    size: String(row.size),
    createdAt: displayDate(row.created_at as string | Date),
    formats: row.formats as ModelVersion['formats'],
    stage: row.stage as ModelVersion['stage'],
    artifactId: row.artifact_id ? String(row.artifact_id) : undefined,
  };
}

export class PgRepository implements Repository {
  constructor(private readonly pool: Pool) {}
  async close() { await this.pool.end(); }
  private async one<T extends Record<string, unknown>>(text: string, values: unknown[], client: PoolClient | Pool = this.pool) { const result = await client.query<T>(text, values); return result.rows[0] ?? null; }
  private async refreshDatasetReviewState(datasetId: string, client: PoolClient | Pool = this.pool) {
    const totals = await this.one<{ total: string; annotated: string; approved: string; submitted: string }>(`
      SELECT COUNT(i.id)::text AS total,
             COUNT(d.image_id) FILTER (WHERE jsonb_array_length(d.annotations) > 0 OR jsonb_array_length(d.captions) > 0 OR jsonb_array_length(COALESCE(d.image_attributes->'tags', '[]'::jsonb)) > 0)::text AS annotated,
             COUNT(d.image_id) FILTER (WHERE d.review_status = 'approved')::text AS approved,
             COUNT(d.image_id) FILTER (WHERE d.review_status = 'submitted')::text AS submitted
      FROM dataset_images i
      LEFT JOIN annotation_documents d ON d.dataset_id = i.dataset_id AND d.image_id = i.id
      WHERE i.dataset_id = $1
    `, [datasetId], client);
    const total = Number(totals?.total ?? 0);
    const approved = Number(totals?.approved ?? 0);
    const submitted = Number(totals?.submitted ?? 0);
    const status: Dataset['status'] = total > 0 && approved === total ? '可训练' : submitted > 0 ? '待审核' : '标注中';
    await client.query('UPDATE datasets SET annotated = $2, status = $3, updated_at = NOW() WHERE id = $1', [datasetId, Number(totals?.annotated ?? 0), status]);
  }
  async findUserByUsername(username: string) { const row = await this.one('SELECT * FROM users WHERE username = $1', [username]); return row ? mapUser(row) : null; }
  async findUserById(id: string) { const row = await this.one('SELECT * FROM users WHERE id = $1', [id]); return row ? mapUser(row) : null; }
  async listDatasets() { const result = await this.pool.query('SELECT * FROM datasets ORDER BY updated_at DESC'); return result.rows.map(mapDataset); }
  async getDataset(id: string) { const row = await this.one('SELECT * FROM datasets WHERE id = $1', [id]); return row ? mapDataset(row) : null; }
  async createDataset(input: { name: string; description: string; version: string; classes: string[] }) {
    const id = `dataset-${randomUUID()}`;
    const row = await this.one('INSERT INTO datasets(id, workspace_id, name, description, version, type, images, annotated, classes, size, status) VALUES ($1,$2,$3,$4,$5,NULL,0,0,$6,$7,$8) RETURNING *', [id, workspaceId, input.name, input.description, input.version, JSON.stringify([...new Set(input.classes)]), '0 B', '标注中']);
    if (!row) throw new Error('Failed to create dataset');
    return mapDataset(row);
  }
  async updateDatasetClasses(id: string, classes: string[]) {
    const row = await this.one('UPDATE datasets SET classes = $2, updated_at = NOW() WHERE id = $1 RETURNING *', [id, JSON.stringify([...new Set(classes)])]);
    return row ? mapDataset(row) : null;
  }
  async getDatasetDeletionPlan(id: string) {
    const dataset = await this.getDataset(id);
    if (!dataset) return null;
    return { dataset, exports: await this.listExports(id) };
  }
  async deleteDataset(id: string) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const artifacts = await client.query<{ id: string }>("SELECT a.id FROM artifacts a JOIN export_tasks e ON e.id = a.source_id WHERE e.dataset_id = $1 AND a.source_type = 'export_task'", [id]);
      const result = await client.query('DELETE FROM datasets WHERE id = $1', [id]);
      if (artifacts.rows.length) await client.query('DELETE FROM artifacts WHERE id = ANY($1::text[])', [artifacts.rows.map((artifact) => artifact.id)]);
      await client.query('COMMIT');
      return result.rowCount === 1;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async listDatasetArtifacts(datasetId: string) { const result = await this.pool.query("SELECT a.* FROM artifacts a JOIN export_tasks e ON e.id = a.source_id WHERE e.dataset_id = $1 AND a.source_type = 'export_task' ORDER BY a.created_at", [datasetId]); return result.rows.map(mapArtifact); }
  async listDatasetImages(datasetId: string) {
    const result = await this.pool.query('SELECT * FROM dataset_images WHERE dataset_id = $1 ORDER BY created_at, id', [datasetId]);
    return result.rows.map(mapDatasetImage).map(({ objectKey: _, ...image }) => image);
  }
  async getDatasetImage(datasetId: string, imageId: string) {
    const row = await this.one('SELECT * FROM dataset_images WHERE dataset_id = $1 AND id = $2', [datasetId, imageId]);
    return row ? mapDatasetImage(row) : null;
  }
  async createDatasetImage(input: { datasetId: string; filename: string; mimeType: string; sizeBytes: number; objectKey: string; split: DatasetImage['split']; width?: number; height?: number }) {
    const id = `image-${randomUUID()}`;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const row = await this.one('INSERT INTO dataset_images(id, dataset_id, object_key, filename, mime_type, size_bytes, width, height, split) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *', [id, input.datasetId, input.objectKey, input.filename, input.mimeType, input.sizeBytes, input.width ?? null, input.height ?? null, input.split], client);
      if (!row) throw new Error('Failed to register dataset image');
      const totals = await this.one<{ image_count: string; size_bytes: string }>('SELECT COUNT(*)::text AS image_count, COALESCE(SUM(size_bytes), 0)::text AS size_bytes FROM dataset_images WHERE dataset_id = $1', [input.datasetId], client);
      if (!totals) throw new Error('Failed to calculate dataset size');
      await client.query("UPDATE datasets SET images = $2, size = $3, status = '标注中', updated_at = NOW() WHERE id = $1", [input.datasetId, Number(totals.image_count), formatBytes(Number(totals.size_bytes))]);
      await client.query('COMMIT');
      const { objectKey: _, ...image } = mapDatasetImage(row);
      return image;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async getAnnotations(datasetId: string, imageId: string) { const row = await this.one('SELECT * FROM annotation_documents WHERE dataset_id = $1 AND image_id = $2', [datasetId, imageId]); return row ? mapAnnotationDocument(row) : { datasetId, imageId, revision: 0, annotations: [], captions: [], imageAttributes: emptyImageAttributes, updatedAt: new Date(0).toISOString(), updatedBy: '', reviewStatus: 'draft' as const }; }
  async saveAnnotations(input: { datasetId: string; imageId: string; revision: number; annotations: AnnotationDocument['annotations']; captions?: AnnotationDocument['captions']; imageAttributes?: AnnotationDocument['imageAttributes']; updatedBy: string }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const image = await this.one('SELECT id FROM dataset_images WHERE dataset_id = $1 AND id = $2', [input.datasetId, input.imageId], client);
      if (!image) throw new RepositoryStateError('ANNOTATION_REVIEW_IMAGE_NOT_FOUND', '标注图像不存在');
      const current = await this.one('SELECT * FROM annotation_documents WHERE dataset_id = $1 AND image_id = $2 FOR UPDATE', [input.datasetId, input.imageId], client);
      if (Number(current?.revision ?? 0) !== input.revision) throw new RepositoryConflictError();
      if (current?.review_status === 'submitted') throw new RepositoryStateError('ANNOTATION_REVIEW_LOCKED', '标注已提交审核，审核完成前不能修改');
      const captions: AnnotationDocument['captions'] = input.captions ?? (current?.captions as AnnotationDocument['captions'] | undefined) ?? [];
      const imageAttributes: AnnotationDocument['imageAttributes'] = input.imageAttributes ?? (current?.image_attributes as AnnotationDocument['imageAttributes'] | undefined) ?? emptyImageAttributes;
      if (imageAttributes.includeInSdxl && !captions.some((caption) => caption.primary && caption.text.trim())) throw new RepositoryStateError('SDXL_CAPTION_REQUIRED', '纳入 SDXL 训练的图片必须填写主 Caption');
      const row = await this.one(`
        INSERT INTO annotation_documents(dataset_id, image_id, revision, annotations, captions, image_attributes, updated_by, review_status)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'draft')
        ON CONFLICT (dataset_id, image_id) DO UPDATE
          SET revision = EXCLUDED.revision, annotations = EXCLUDED.annotations, captions = EXCLUDED.captions,
              image_attributes = EXCLUDED.image_attributes, updated_by = EXCLUDED.updated_by,
              updated_at = NOW(), review_status = 'draft', submitted_at = NULL, submitted_by = NULL,
              reviewed_at = NULL, reviewed_by = NULL, review_comment = NULL
        RETURNING *
      `, [input.datasetId, input.imageId, input.revision + 1, JSON.stringify(input.annotations), JSON.stringify(captions), JSON.stringify(imageAttributes), input.updatedBy], client);
      if (!row) throw new Error('Failed to save annotations');
      await this.refreshDatasetReviewState(input.datasetId, client);
      await client.query('COMMIT');
      return mapAnnotationDocument(row);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async getAnnotationReviewSummary(datasetId: string) {
    const dataset = await this.getDataset(datasetId);
    if (!dataset) throw new RepositoryStateError('DATASET_NOT_FOUND', '数据集不存在');
    const result = await this.pool.query(`
      SELECT i.id AS image_id, i.filename, d.revision,
             CASE WHEN d.image_id IS NULL THEN 0 ELSE jsonb_array_length(d.annotations) + jsonb_array_length(d.captions) + jsonb_array_length(COALESCE(d.image_attributes->'tags', '[]'::jsonb)) END AS annotation_count,
             COALESCE(d.review_status, 'draft') AS review_status,
             d.submitted_at, d.submitted_by, d.reviewed_at, d.reviewed_by, d.review_comment
      FROM dataset_images i
      LEFT JOIN annotation_documents d ON d.dataset_id = i.dataset_id AND d.image_id = i.id
      WHERE i.dataset_id = $1
      ORDER BY i.created_at, i.id
    `, [datasetId]);
    const items = result.rows.map(mapAnnotationReviewItem);
    return {
      datasetId,
      datasetStatus: dataset.status,
      total: items.length,
      draft: items.filter((item) => item.reviewStatus === 'draft').length,
      submitted: items.filter((item) => item.reviewStatus === 'submitted').length,
      approved: items.filter((item) => item.reviewStatus === 'approved').length,
      rejected: items.filter((item) => item.reviewStatus === 'rejected').length,
      items,
    };
  }
  async submitAnnotationReview(datasetId: string, submittedBy: string) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const dataset = await this.one('SELECT id FROM datasets WHERE id = $1 FOR UPDATE', [datasetId], client);
      if (!dataset) throw new RepositoryStateError('DATASET_NOT_FOUND', '数据集不存在');
      const result = await client.query(`
        SELECT i.id, d.image_id, d.annotations, d.captions, d.image_attributes
        FROM dataset_images i
        LEFT JOIN annotation_documents d ON d.dataset_id = i.dataset_id AND d.image_id = i.id
        WHERE i.dataset_id = $1
      `, [datasetId]);
      if (!result.rowCount || result.rows.some((row) => !row.image_id || !annotationDocumentHasContent({ annotations: Array.isArray(row.annotations) ? row.annotations : [], captions: Array.isArray(row.captions) ? row.captions : [], imageAttributes: row.image_attributes ?? emptyImageAttributes }))) {
        throw new RepositoryStateError('ANNOTATION_REVIEW_INCOMPLETE', '请完成全部图像标注后再提交审核');
      }
      await client.query(`
        UPDATE annotation_documents
        SET review_status = 'submitted', submitted_at = NOW(), submitted_by = $2,
            reviewed_at = NULL, reviewed_by = NULL, review_comment = NULL
        WHERE dataset_id = $1 AND review_status <> 'approved'
      `, [datasetId, submittedBy]);
      await this.refreshDatasetReviewState(datasetId, client);
      await client.query('COMMIT');
      return this.getAnnotationReviewSummary(datasetId);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async decideAnnotationReview(datasetId: string, input: AnnotationReviewDecisionInput & { reviewedBy: string }) {
    const imageIds = [...new Set(input.imageIds)];
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const dataset = await this.one('SELECT id FROM datasets WHERE id = $1 FOR UPDATE', [datasetId], client);
      if (!dataset) throw new RepositoryStateError('DATASET_NOT_FOUND', '数据集不存在');
      const result = await client.query('SELECT image_id, review_status FROM annotation_documents WHERE dataset_id = $1 AND image_id = ANY($2::text[]) FOR UPDATE', [datasetId, imageIds]);
      if (result.rowCount !== imageIds.length) throw new RepositoryStateError('ANNOTATION_REVIEW_IMAGE_NOT_FOUND', '审核图像不存在');
      if (result.rows.some((row) => row.review_status !== 'submitted')) throw new RepositoryStateError('ANNOTATION_REVIEW_INVALID_STATE', '只能审核处于待审核状态的图像');
      await client.query(`
        UPDATE annotation_documents
        SET review_status = $3, reviewed_at = NOW(), reviewed_by = $4, review_comment = $5
        WHERE dataset_id = $1 AND image_id = ANY($2::text[])
      `, [datasetId, imageIds, input.decision === 'approve' ? 'approved' : 'rejected', input.reviewedBy, input.comment ?? null]);
      await this.refreshDatasetReviewState(datasetId, client);
      await client.query('COMMIT');
      return this.getAnnotationReviewSummary(datasetId);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async listTrainingJobs() { const result = await this.pool.query('SELECT * FROM training_jobs ORDER BY created_at DESC'); return result.rows.map(mapJob); }
  async getTrainingJob(id: string) { const row = await this.one('SELECT * FROM training_jobs WHERE id = $1', [id]); return row ? mapJob(row) : null; }
  async listTrainingEvents(jobId: string) { const result = await this.pool.query('SELECT * FROM training_events WHERE job_id = $1 ORDER BY created_at, id', [jobId]); return result.rows.map(mapTrainingEvent); }
  async getTrainingObservability(jobId: string) {
    const [metrics, resources] = await Promise.all([
      this.pool.query('SELECT * FROM (SELECT * FROM training_metrics WHERE job_id = $1 ORDER BY epoch DESC, id DESC LIMIT 500) recent ORDER BY epoch, id', [jobId]),
      this.pool.query('SELECT * FROM training_resource_samples WHERE job_id = $1 ORDER BY created_at, id LIMIT 600', [jobId]),
    ]);
    return { metrics: metrics.rows.map(mapTrainingMetric), resources: resources.rows.map(mapTrainingResource) };
  }
  async createTrainingJob(input: { draft: TrainingDraft; datasetName: string; createdBy: string; retrySourceId?: string }) { const job = newTrainingJob(input); const row = await this.one('INSERT INTO training_jobs(id, workspace_id, name, type, model, dataset, status, progress, epoch, metric_name, metric_value, gpu, eta, created_by, config) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *', [job.id, workspaceId, job.name, job.type, job.model, job.dataset, job.status, job.progress, job.epoch, job.metricName, job.metricValue, job.gpu, job.eta, input.createdBy, JSON.stringify(input.draft)]); if (!row) throw new Error('Failed to create training job'); const message = input.retrySourceId ? `由失败任务 ${input.retrySourceId} 重新创建并进入资源队列` : '训练任务已创建并进入资源队列'; await this.pool.query('INSERT INTO training_events(workspace_id, job_id, level, message) VALUES ($1,$2,$3,$4)', [workspaceId, job.id, 'info', message]); return mapJob(row); }
  async cancelTrainingJob(id: string) { const row = await this.one('UPDATE training_jobs SET status = \'cancelled\', eta = \'已取消\', updated_at = NOW() WHERE id = $1 AND status IN (\'queued\', \'running\') RETURNING *', [id]); if (row) { await this.pool.query('INSERT INTO training_events(workspace_id, job_id, level, message) VALUES ($1,$2,$3,$4)', [row.workspace_id, id, 'warning', '训练任务已由用户取消']); return mapJob(row); } return this.getTrainingJob(id); }
  async getTrainingDeletionPlan(id: string) {
    const job = await this.getTrainingJob(id);
    if (!job) return null;
    const [models, conversions] = await Promise.all([
      this.pool.query('SELECT * FROM model_versions WHERE source_job = $1 ORDER BY created_at', [id]),
      this.pool.query('SELECT c.* FROM conversion_jobs c JOIN model_versions m ON m.workspace_id = c.workspace_id AND m.name = c.model_name AND m.version = c.model_version WHERE m.source_job = $1 ORDER BY c.created_at', [id]),
    ]);
    return { job, models: models.rows.map(mapModel), conversions: conversions.rows.map(mapConversion) };
  }
  async deleteTrainingJob(id: string) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const models = await client.query<{ id: string; artifact_id: string | null }>('SELECT id, artifact_id FROM model_versions WHERE source_job = $1 FOR UPDATE', [id]);
      const conversions = await client.query<{ id: string; artifact_id: string | null }>('SELECT c.id, c.artifact_id FROM conversion_jobs c JOIN model_versions m ON m.workspace_id = c.workspace_id AND m.name = c.model_name AND m.version = c.model_version WHERE m.source_job = $1 FOR UPDATE OF c', [id]);
      const artifactIds = [
        ...(await client.query<{ artifact_id: string | null }>('SELECT artifact_id FROM training_jobs WHERE id = $1 FOR UPDATE', [id])).rows.map((row) => row.artifact_id),
        ...models.rows.map((row) => row.artifact_id),
        ...conversions.rows.map((row) => row.artifact_id),
      ].filter((artifactId): artifactId is string => Boolean(artifactId));
      const conversionIds = conversions.rows.map((row) => row.id);
      if (conversionIds.length) await client.query('DELETE FROM conversion_jobs WHERE id = ANY($1::text[])', [conversionIds]);
      await client.query('DELETE FROM model_versions WHERE source_job = $1', [id]);
      const result = await client.query('DELETE FROM training_jobs WHERE id = $1', [id]);
      if (conversionIds.length) await client.query("DELETE FROM artifacts WHERE source_type = 'conversion_job' AND source_id = ANY($1::text[])", [conversionIds]);
      await client.query("DELETE FROM artifacts WHERE source_type = 'training_job' AND source_id = $1", [id]);
      if (artifactIds.length) await client.query('DELETE FROM artifacts WHERE id = ANY($1::text[])', [artifactIds]);
      await client.query('COMMIT');
      return (result.rowCount ?? 0) > 0;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async listModels() { const result = await this.pool.query('SELECT * FROM model_versions ORDER BY created_at DESC'); return result.rows.map(mapModel); }
  async getModel(id: string) { const row = await this.one('SELECT * FROM model_versions WHERE id = $1', [id]); return row ? mapModel(row) : null; }
  async getModelByNameVersion(name: string, version: string) { const row = await this.one('SELECT * FROM model_versions WHERE workspace_id = $1 AND name = $2 AND version = $3', [workspaceId, name, version]); return row ? mapModel(row) : null; }
  async createUploadedModel(input: { id: string; artifactId: string; name: string; version: string; task: ModelVersion['task']; framework: string; stage: ModelVersion['stage']; objectKey: string; filename: string; mimeType: string; sizeBytes: number; sha256: string; createdBy: string }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO artifacts(id, workspace_id, object_key, filename, mime_type, size_bytes, sha256, source_type, source_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [input.artifactId, workspaceId, input.objectKey, input.filename, input.mimeType, input.sizeBytes, input.sha256, 'model_upload', input.id, input.createdBy]);
      const row = await this.one('INSERT INTO model_versions(id, workspace_id, name, version, task, source_job, metric_name, metric_value, framework, size, formats, stage, artifact_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *', [input.id, workspaceId, input.name, input.version, input.task, 'manual-upload', '待评估', '--', input.framework, formatBytes(input.sizeBytes), JSON.stringify([]), input.stage, input.artifactId], client);
      if (!row) throw new Error('Failed to register uploaded model');
      await client.query('COMMIT');
      return mapModel(row);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async updateModelStage(id: string, stage: ModelVersion['stage']) { const row = await this.one('UPDATE model_versions SET stage = $2 WHERE id = $1 RETURNING *', [id, stage]); return row ? mapModel(row) : null; }
  async getModelDeletionPlan(id: string) {
    const model = await this.getModel(id);
    if (!model) return null;
    const conversions = await this.pool.query('SELECT * FROM conversion_jobs WHERE workspace_id = $1 AND model_name = $2 AND model_version = $3 ORDER BY created_at', [workspaceId, model.name, model.version]);
    return { model, conversions: conversions.rows.map(mapConversion) };
  }
  async deleteModel(id: string) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const modelRow = await this.one<Record<string, unknown>>('SELECT * FROM model_versions WHERE id = $1 FOR UPDATE', [id], client);
      if (!modelRow) {
        await client.query('ROLLBACK');
        return false;
      }
      const model = mapModel(modelRow);
      const conversions = await client.query<{ id: string; artifact_id: string | null }>('SELECT id, artifact_id FROM conversion_jobs WHERE workspace_id = $1 AND model_name = $2 AND model_version = $3 FOR UPDATE', [workspaceId, model.name, model.version]);
      const conversionIds = conversions.rows.map((row) => row.id);
      const artifactIds = [model.artifactId, ...conversions.rows.map((row) => row.artifact_id)].filter((artifactId): artifactId is string => Boolean(artifactId));
      if (artifactIds.length) await client.query('UPDATE training_jobs SET artifact_id = NULL WHERE artifact_id = ANY($1::text[])', [artifactIds]);
      if (conversionIds.length) await client.query('DELETE FROM conversion_jobs WHERE id = ANY($1::text[])', [conversionIds]);
      await client.query('DELETE FROM model_versions WHERE id = $1', [id]);
      if (conversionIds.length) await client.query("DELETE FROM artifacts WHERE source_type = 'conversion_job' AND source_id = ANY($1::text[])", [conversionIds]);
      await client.query("DELETE FROM artifacts WHERE source_type = 'model_upload' AND source_id = $1", [id]);
      if (artifactIds.length) await client.query('DELETE FROM artifacts WHERE id = ANY($1::text[])', [artifactIds]);
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async listConversions() { const result = await this.pool.query('SELECT * FROM conversion_jobs ORDER BY created_at DESC'); return result.rows.map(mapConversion); }
  async getConversion(id: string) { const row = await this.one('SELECT * FROM conversion_jobs WHERE id = $1', [id]); return row ? mapConversion(row) : null; }
  async createConversion(input: { modelName: string; modelVersion: string; format: ConversionTask['format']; precision: string; target: string; options: Record<string, string | boolean>; createdBy: string }) { const task: ConversionTask = { id: `convert-${randomUUID()}`, ...input, status: 'queued', progress: 0, size: '计算中', createdAt: new Date().toISOString() }; const row = await this.one('INSERT INTO conversion_jobs(id, workspace_id, model_name, model_version, format, precision, target, status, progress, size, created_by, config) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *', [task.id, workspaceId, task.modelName, task.modelVersion, task.format, task.precision, task.target, task.status, task.progress, task.size, task.createdBy, JSON.stringify(input.options)]); if (!row) throw new Error('Failed to create conversion job'); return mapConversion(row); }
  async cancelConversion(id: string) { const row = await this.one('UPDATE conversion_jobs SET status = \'cancelled\', updated_at = NOW() WHERE id = $1 AND status IN (\'queued\', \'running\') RETURNING *', [id]); return row ? mapConversion(row) : this.getConversion(id); }
  async deleteConversion(id: string) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const task = await this.one<{ artifact_id: string | null }>('SELECT artifact_id FROM conversion_jobs WHERE id = $1 AND workspace_id = $2 FOR UPDATE', [id, workspaceId], client);
      if (!task) {
        await client.query('ROLLBACK');
        return false;
      }
      await client.query('DELETE FROM conversion_jobs WHERE id = $1 AND workspace_id = $2', [id, workspaceId]);
      await client.query("DELETE FROM artifacts WHERE workspace_id = $1 AND source_type = 'conversion_job' AND source_id = $2", [workspaceId, id]);
      if (task.artifact_id) await client.query('DELETE FROM artifacts WHERE id = $1 AND workspace_id = $2', [task.artifact_id, workspaceId]);
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async createExport(input: { datasetId: string; format: ExportTask['format']; scope: NonNullable<ExportTask['scope']>; versionName: string; includeImages: boolean; createdBy: string }) { const task: ExportTask = { id: `export-${randomUUID()}`, datasetId: input.datasetId, format: input.format, scope: input.scope, versionName: input.versionName, includeImages: input.includeImages, status: 'queued', progress: 0, createdAt: new Date().toISOString() }; await this.pool.query('INSERT INTO export_tasks(id, workspace_id, dataset_id, format, scope, version_name, include_images, status, progress, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [task.id, workspaceId, task.datasetId, task.format, task.scope, task.versionName, task.includeImages, task.status, task.progress, input.createdBy]); return task; }
  async listExports(datasetId: string) { const result = await this.pool.query('SELECT * FROM export_tasks WHERE dataset_id = $1 ORDER BY created_at DESC', [datasetId]); return result.rows.map(mapExport); }
  async getExport(id: string) { const row = await this.one('SELECT * FROM export_tasks WHERE id = $1', [id]); return row ? mapExport(row) : null; }
  async getArtifact(id: string) { const row = await this.one('SELECT * FROM artifacts WHERE id = $1', [id]); return row ? mapArtifact(row) : null; }
  async listRecentActivities(limit: number) {
    const result = await this.pool.query(`
      SELECT audit_logs.*, users.display_name AS actor_name
      FROM audit_logs
      LEFT JOIN users ON users.id = audit_logs.actor_id
      WHERE audit_logs.action <> 'auth.login'
      ORDER BY audit_logs.created_at DESC, audit_logs.id DESC
      LIMIT $1
    `, [limit]);
    return result.rows.map(mapWorkspaceActivity);
  }
  async writeAudit(input: { actorId: string; action: string; entityType: string; entityId?: string; metadata?: Record<string, unknown> }) { await this.pool.query('INSERT INTO audit_logs(actor_id, action, entity_type, entity_id, metadata) VALUES ($1,$2,$3,$4,$5)', [input.actorId, input.action, input.entityType, input.entityId ?? null, JSON.stringify(input.metadata ?? {})]); }
}

export function createRepository(databaseUrl?: string): Repository {
  if (!databaseUrl) return new MemoryRepository();
  return new PgRepository(new Pool({ connectionString: databaseUrl, max: 10 }));
}
