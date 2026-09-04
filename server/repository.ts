import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Pool, type PoolClient } from 'pg';
import type { AnnotationJob, AnnotationJobStatus, AnnotationReviewDecisionInput, AnnotationReviewItem, AnnotationReviewSummary, AnnotationSegment, AnnotationStatistics, AnnotationTask, AnnotationTaskStatus, Artifact, AuthUser, AnnotationDocument, AnnotationRecord, ConversionTask, Dataset, DatasetDeletionPreview, DatasetImage, DatasetLabel, DatasetProcessingConfig, ExportTask, ModelVersion, ProcessingRun, SourceAsset, SystemSettings, TrainingDraft, TrainingEvent, TrainingJob, TrainingObservability, TrainingMetricPoint, TrainingResourceSample, TrainingSnapshot, UploadSession, UploadStatus, UserRole, WorkspaceActivity } from '../shared/contracts';
import { roleAliases } from '../shared/contracts';
import { attributeAnnotations } from './annotationAttribution';
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

export interface SaveAnnotationsInput {
  datasetId: string;
  imageId: string;
  revision: number;
  annotations: AnnotationRecord[];
  captions?: AnnotationDocument['captions'];
  imageAttributes?: AnnotationDocument['imageAttributes'];
  updatedBy: string;
  updatedByRole?: UserRole;
  reviewJobId?: string;
  reviewerId?: string;
}

export interface Repository {
  close(): Promise<void>;
  findUserByUsername(username: string): Promise<StoredUser | null>;
  findUserById(id: string): Promise<StoredUser | null>;
  listUsers(): Promise<AuthUser[]>;
  deleteUser(id: string): Promise<boolean>;
  createUser(input: { username: string; displayName: string; password: string; roles: UserRole[] }): Promise<AuthUser>;
  updateUser(id: string, input: { displayName?: string; roles?: UserRole[]; enabled?: boolean; password?: string }): Promise<AuthUser | null>;
  getSettings(): Promise<SystemSettings>;
  updateSettings(input: Partial<SystemSettings>): Promise<SystemSettings>;
  listDatasetAssets(datasetId: string): Promise<SourceAsset[]>;
  createSourceAsset(input: { datasetId: string; type: SourceAsset['type']; filename: string; mimeType: string; sizeBytes: number; sha256?: string; objectKey: string }): Promise<SourceAsset>;
  markSourceAssetUploaded(id: string, sha256: string): Promise<SourceAsset | null>;
  createUploadSession(input: { datasetId: string; assetId: string; filename: string; mimeType: string; sizeBytes: number; partSize: number; totalParts: number; expiresAt: string }): Promise<UploadSession>;
  getUploadSession(id: string): Promise<UploadSession | null>;
  listUploadSessions(datasetId: string): Promise<UploadSession[]>;
  updateUploadSession(id: string, input: { completedParts?: number[]; status?: UploadStatus; sha256?: string }): Promise<UploadSession | null>;
  cancelUploadSession(id: string): Promise<boolean>;
  createAnnotationTask(datasetId: string): Promise<AnnotationTask>;
  getAnnotationTask(datasetId: string): Promise<AnnotationTask | null>;
  updateAnnotationTaskStatus(datasetId: string, status: AnnotationTaskStatus): Promise<AnnotationTask | null>;
  createProcessingRun(input: Pick<ProcessingRun, 'datasetId' | 'sourceAssetId' | 'extractionStrategy' | 'frameStep' | 'startFrame' | 'endFrame' | 'segmentSize' | 'imageQuality' | 'overlapSize' | 'blockSize' | 'useZipBlocks' | 'zOrder'>): Promise<ProcessingRun>;
  getProcessingRun(id: string): Promise<ProcessingRun | null>;
  listProcessingRuns(datasetId: string): Promise<ProcessingRun[]>;
  createAnnotationSegments(segments: Array<Omit<AnnotationSegment, 'createdAt'>>): Promise<AnnotationSegment[]>;
  listAnnotationSegments(datasetId: string): Promise<AnnotationSegment[]>;
  listAnnotationJobs(datasetId: string): Promise<AnnotationJob[]>;
  getAnnotationJob(id: string): Promise<AnnotationJob | null>;
  claimNextAnnotationJob(datasetId: string, assigneeId: string): Promise<AnnotationJob | null>;
  submitAnnotationJob(id: string, assigneeId: string): Promise<AnnotationJob | null>;
  claimAnnotationReviewJob(id: string, reviewerId: string, isAdmin?: boolean): Promise<AnnotationJob | null>;
  claimNextAnnotationReviewJob(datasetId: string, reviewerId: string, isAdmin?: boolean): Promise<AnnotationJob | null>;
  reviewAnnotationJob(id: string, reviewerId: string, decision: 'approve' | 'reject', comment?: string): Promise<AnnotationJob | null>;
  reviewAnnotationJobs(ids: string[], reviewerId: string, decision: 'approve' | 'reject', comment?: string): Promise<AnnotationJob[]>;
  reopenAnnotationJob(id: string, adminId: string, reason: string): Promise<AnnotationJob | null>;
  updateAnnotationJob(id: string, input: { status?: AnnotationJobStatus; assigneeId?: string | null; reviewComment?: string }): Promise<AnnotationJob | null>;
  releaseAnnotationJob(id: string, assigneeId: string, force: boolean): Promise<AnnotationJob | null>;
  reassignAnnotationJob(id: string, assigneeId: string): Promise<AnnotationJob | null>;
  listDatasets(): Promise<Dataset[]>;
  getDataset(id: string): Promise<Dataset | null>;
  createDataset(input: { name: string; description: string; version: string; classes: string[]; labels?: DatasetLabel[]; annotatorIds?: string[]; reviewerIds?: string[]; processingConfig?: DatasetProcessingConfig }): Promise<Dataset>;
  updateDatasetClasses(id: string, classes: string[]): Promise<Dataset | null>;
  updateDatasetLabels(id: string, labels: DatasetLabel[]): Promise<Dataset | null>;
  getDatasetDeletionPlan(id: string): Promise<DatasetDeletionPlan | null>;
  getDatasetDeletionPreview(id: string): Promise<DatasetDeletionPreview | null>;
  deleteDataset(id: string): Promise<boolean>;
  listDatasetArtifacts(datasetId: string): Promise<Artifact[]>;
  listDatasetImages(datasetId: string): Promise<DatasetImage[]>;
  getDatasetImage(datasetId: string, imageId: string): Promise<DatasetImage & { objectKey: string } | null>;
  createDatasetImage(input: { datasetId: string; filename: string; mimeType: string; sizeBytes: number; objectKey: string; split: DatasetImage['split']; width?: number; height?: number }): Promise<DatasetImage>;
  getAnnotations(datasetId: string, imageId: string): Promise<AnnotationDocument | null>;
  saveAnnotations(input: SaveAnnotationsInput): Promise<AnnotationDocument>;
  getAnnotationReviewSummary(datasetId: string): Promise<AnnotationReviewSummary>;
  submitAnnotationReview(datasetId: string, submittedBy: string): Promise<AnnotationReviewSummary>;
  decideAnnotationReview(datasetId: string, input: AnnotationReviewDecisionInput & { reviewedBy: string }): Promise<AnnotationReviewSummary>;
  listTrainingJobs(): Promise<TrainingJob[]>;
  getTrainingJob(id: string): Promise<TrainingJob | null>;
  listTrainingEvents(jobId: string): Promise<TrainingEvent[]>;
  getTrainingObservability(jobId: string): Promise<TrainingObservability>;
  createTrainingSnapshot(input: { datasetId: string; jobIds?: string[]; createdBy: string }): Promise<TrainingSnapshot>;
  getTrainingSnapshot(id: string): Promise<TrainingSnapshot | null>;
  createTrainingJob(input: { draft: TrainingDraft; datasetName: string; createdBy: string; retrySourceId?: string; snapshotId?: string }): Promise<TrainingJob>;
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
  getAnnotationStatistics(datasetId: string | undefined, actor: Pick<AuthUser, 'id' | 'role'>): Promise<AnnotationStatistics>;
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

function approvedEmptyAnnotationDocument(datasetId: string, imageId: string): AnnotationDocument {
  return { datasetId, imageId, revision: 0, annotations: [], captions: [], imageAttributes: emptyImageAttributes, updatedAt: new Date(0).toISOString(), updatedBy: '', reviewStatus: 'approved' };
}

function annotationDocumentHasContent(document: Pick<AnnotationDocument, 'annotations' | 'captions' | 'imageAttributes'>) {
  return document.annotations.length > 0 || document.captions.length > 0 || document.imageAttributes.tags.length > 0;
}

function newTrainingJob(input: { draft: TrainingDraft; datasetName: string; createdBy: string }): TrainingJob {
  const metric = input.draft.model.endsWith('-seg') || input.draft.model.endsWith('-pose') ? ['mAP@50', '--'] : input.draft.type === 'segmentation' ? ['mIoU', '--'] : input.draft.type === 'keypoint' ? ['OKS', '--'] : input.draft.type === 'sdxl' ? ['Loss', '--'] : ['mAP@50', '--'];
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
  private readonly settings: SystemSettings = { uploadMaxBytes: 512 * 1024 * 1024, defaultImageSegmentSize: 100, defaultVideoSegmentSize: 100, autosaveIntervalSeconds: 5, retentionDays: 30, allowedVideoFormats: ['mp4', 'mov', 'avi', 'mkv'] };
  private readonly assets: SourceAsset[] = [];
  private readonly uploadSessions: UploadSession[] = [];
  private readonly annotationTasks: AnnotationTask[] = [];
  private readonly processingRuns: ProcessingRun[] = [];
  private readonly annotationSegments: AnnotationSegment[] = [];
  private readonly annotationJobs: AnnotationJob[] = [];
  private readonly trainingSnapshots = new Map<string, TrainingSnapshot>();

  constructor(fixtures: MemoryRepositoryFixtures = {}) {
    this.users = (fixtures.users ?? []).map((user) => ({ ...user, role: roleAliases[user.role], roles: [roleAliases[user.role]], enabled: user.enabled ?? true, passwordHash: bcrypt.hashSync(user.password, 10) }));
    this.datasets = structuredClone(fixtures.datasets ?? []);
    this.jobs = structuredClone(fixtures.jobs ?? []);
    this.models = structuredClone(fixtures.models ?? []);
    this.conversions = structuredClone(fixtures.conversions ?? []);
  }

  async close() {}

  async findUserByUsername(username: string) { return this.users.find((user) => user.username === username) ?? null; }
  async findUserById(id: string) { return this.users.find((user) => user.id === id) ?? null; }
  async listUsers() { return structuredClone(this.users.map(({ passwordHash: _, ...user }) => user)); }
  async createUser(input: { username: string; displayName: string; password: string; roles: UserRole[] }) {
    if (this.users.some((user) => user.username === input.username)) throw new RepositoryStateError('USERNAME_CONFLICT', '用户名已存在');
    const role = roleAliases[input.roles[0]];
    if (!role) throw new RepositoryStateError('USER_ROLE_REQUIRED', '用户必须绑定一个角色');
    const user: StoredUser = { id: `user-${randomUUID()}`, workspaceId, username: input.username, displayName: input.displayName, role, roles: [role], enabled: true, mustChangePassword: true, passwordHash: bcrypt.hashSync(input.password, 10) };
    this.users.push(user);
    const { passwordHash: _, ...publicUser } = user;
    return structuredClone(publicUser);
  }
  async updateUser(id: string, input: { displayName?: string; roles?: UserRole[]; enabled?: boolean; password?: string }) {
    const user = this.users.find((item) => item.id === id);
    if (!user) return null;
    if (input.displayName !== undefined) user.displayName = input.displayName;
    if (input.roles) {
      const role = roleAliases[input.roles[0]];
      if (!role) throw new RepositoryStateError('USER_ROLE_REQUIRED', '用户必须绑定一个角色');
      user.role = role;
      user.roles = [role];
    }
    if (input.enabled !== undefined) user.enabled = input.enabled;
    if (input.password) { user.passwordHash = bcrypt.hashSync(input.password, 10); user.mustChangePassword = true; }
    const { passwordHash: _, ...publicUser } = user;
    return structuredClone(publicUser);
  }
  async deleteUser(id: string) {
    const index = this.users.findIndex((item) => item.id === id);
    if (index < 0) return false;
    this.users.splice(index, 1);
    for (const dataset of this.datasets) {
      dataset.annotatorIds = (dataset.annotatorIds ?? []).filter((userId) => userId !== id);
      dataset.reviewerIds = (dataset.reviewerIds ?? []).filter((userId) => userId !== id);
    }
    for (const job of this.annotationJobs) {
      if (job.assigneeId === id) delete job.assigneeId;
      if (job.reviewerId === id) delete job.reviewerId;
    }
    return true;
  }
  async getSettings() { return structuredClone(this.settings); }
  async updateSettings(input: Partial<SystemSettings>) { Object.assign(this.settings, input); return structuredClone(this.settings); }
  async listDatasetAssets(datasetId: string) { return structuredClone(this.assets.filter((asset) => asset.datasetId === datasetId)); }
  async createSourceAsset(input: { datasetId: string; type: SourceAsset['type']; filename: string; mimeType: string; sizeBytes: number; sha256?: string; objectKey: string }) { const asset: SourceAsset = { id: `asset-${randomUUID()}`, ...input, uploadStatus: 'created', processingStatus: 'pending', createdAt: new Date().toISOString() }; this.assets.push(asset); return structuredClone(asset); }
  async markSourceAssetUploaded(id: string, sha256: string) { const asset = this.assets.find((item) => item.id === id); if (!asset) return null; asset.sha256 = sha256; asset.uploadStatus = 'uploaded'; return structuredClone(asset); }
  async createUploadSession(input: { datasetId: string; assetId: string; filename: string; mimeType: string; sizeBytes: number; partSize: number; totalParts: number; expiresAt: string }) { const session: UploadSession = { id: `upload-${randomUUID()}`, ...input, completedParts: [], status: 'created', createdAt: new Date().toISOString() }; this.uploadSessions.push(session); return structuredClone(session); }
  async getUploadSession(id: string) { return structuredClone(this.uploadSessions.find((session) => session.id === id) ?? null); }
  async listUploadSessions(datasetId: string) { return structuredClone(this.uploadSessions.filter((session) => session.datasetId === datasetId)); }
  async updateUploadSession(id: string, input: { completedParts?: number[]; status?: UploadStatus; sha256?: string }) { const session = this.uploadSessions.find((item) => item.id === id); if (!session) return null; if (input.completedParts) session.completedParts = [...new Set(input.completedParts)].sort((a, b) => a - b); if (input.status) session.status = input.status; const asset = this.assets.find((item) => item.id === session.assetId); if (asset && input.status) asset.uploadStatus = input.status; if (asset && input.sha256) asset.sha256 = input.sha256; return structuredClone(session); }
  async cancelUploadSession(id: string) { const session = this.uploadSessions.find((item) => item.id === id); if (!session || session.status === 'uploaded') return false; session.status = 'cancelled'; const asset = this.assets.find((item) => item.id === session.assetId); if (asset) asset.uploadStatus = 'cancelled'; return true; }
  async createAnnotationTask(datasetId: string) { const existing = this.annotationTasks.find((task) => task.datasetId === datasetId); if (existing) return structuredClone(existing); const task: AnnotationTask = { id: `annotation-task-${randomUUID()}`, datasetId, name: '默认标注任务', status: 'draft', createdAt: new Date().toISOString() }; this.annotationTasks.push(task); return structuredClone(task); }
  async getAnnotationTask(datasetId: string) { return structuredClone(this.annotationTasks.find((task) => task.datasetId === datasetId) ?? null); }
  async updateAnnotationTaskStatus(datasetId: string, status: AnnotationTaskStatus) { const task = this.annotationTasks.find((item) => item.datasetId === datasetId); if (!task) return null; task.status = status; return structuredClone(task); }
  async createProcessingRun(input: Pick<ProcessingRun, 'datasetId' | 'sourceAssetId' | 'extractionStrategy' | 'frameStep' | 'startFrame' | 'endFrame' | 'segmentSize' | 'imageQuality' | 'overlapSize' | 'blockSize' | 'useZipBlocks' | 'zOrder'>) { const run: ProcessingRun = { id: `processing-${randomUUID()}`, ...input, extractionStrategy: 'frame_step', frameStep: input.frameStep ?? 1, overlapSize: input.overlapSize ?? 0, useZipBlocks: input.useZipBlocks ?? false, zOrder: input.zOrder ?? false, status: 'queued', progress: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }; this.processingRuns.push(run); return structuredClone(run); }
  async getProcessingRun(id: string) { return structuredClone(this.processingRuns.find((run) => run.id === id) ?? null); }
  async listProcessingRuns(datasetId: string) { return structuredClone(this.processingRuns.filter((run) => run.datasetId === datasetId)); }
  async createAnnotationSegments(segments: Array<Omit<AnnotationSegment, 'createdAt'>>) { const created = segments.map((segment) => ({ ...segment, createdAt: new Date().toISOString() })); this.annotationSegments.push(...created); for (const segment of created) if (!this.annotationJobs.some((job) => job.segmentId === segment.id)) this.annotationJobs.push({ id: `job-${randomUUID()}`, datasetId: segment.datasetId, annotationTaskId: segment.annotationTaskId, segmentId: segment.id, sequence: segment.sequence, status: 'available', createdAt: segment.createdAt }); return structuredClone(created); }
  async listAnnotationSegments(datasetId: string) { return structuredClone(this.annotationSegments.filter((segment) => segment.datasetId === datasetId).sort((a, b) => a.sequence - b.sequence)); }
  async listAnnotationJobs(datasetId: string) { return structuredClone(this.annotationJobs.filter((job) => job.datasetId === datasetId).sort((a, b) => a.sequence - b.sequence)); }
  async getAnnotationJob(id: string) { return structuredClone(this.annotationJobs.find((job) => job.id === id) ?? null); }
  async claimAnnotationReviewJob(id: string, reviewerId: string, isAdmin = false) { const job = this.annotationJobs.find((item) => item.id === id); const dataset = job ? this.datasets.find((item) => item.id === job.datasetId) : undefined; const reviewerIds = dataset?.reviewerIds ?? []; if (!job || job.status !== 'submitted' || job.assigneeId === reviewerId || (!isAdmin && reviewerIds.length > 0 && !reviewerIds.includes(reviewerId))) return null; job.status = 'reviewing'; job.reviewerId = reviewerId; return structuredClone(job); }
  async claimNextAnnotationReviewJob(datasetId: string, reviewerId: string, isAdmin = false) { const dataset = this.datasets.find((item) => item.id === datasetId); const reviewerIds = dataset?.reviewerIds ?? []; if (!isAdmin && reviewerIds.length && !reviewerIds.includes(reviewerId)) return null; const job = this.annotationJobs.filter((item) => item.datasetId === datasetId && item.status === 'submitted' && item.assigneeId !== reviewerId).sort((a, b) => a.sequence - b.sequence)[0]; if (!job) return null; job.status = 'reviewing'; job.reviewerId = reviewerId; return structuredClone(job); }
  async reviewAnnotationJob(id: string, reviewerId: string, decision: 'approve' | 'reject', comment?: string) { if (decision === 'reject' && !comment) throw new RepositoryStateError('REVIEW_COMMENT_REQUIRED', '驳回必须填写原因'); const job = this.annotationJobs.find((item) => item.id === id); if (!job || job.status !== 'reviewing' || job.reviewerId !== reviewerId) return null; const reviewedAt = new Date().toISOString(); job.status = decision === 'approve' ? 'approved' : 'rework'; job.reviewComment = comment; job.reviewedAt = reviewedAt; for (const image of this.segmentImages(job.segmentId)) { const document = this.annotations.get(`${job.datasetId}:${image.id}`); if (document) { document.reviewStatus = decision === 'approve' ? 'approved' : 'rejected'; document.reviewedAt = reviewedAt; document.reviewedBy = reviewerId; document.reviewComment = comment; } } if (decision === 'reject') delete job.reviewerId; this.refreshDatasetReviewState(job.datasetId); return structuredClone(job); }
  async claimNextAnnotationJob(datasetId: string, assigneeId: string) {
    const dataset = this.datasets.find((item) => item.id === datasetId);
    const task = this.annotationTasks.find((item) => item.datasetId === datasetId);
    const annotatorIds = dataset?.annotatorIds ?? [];
    if (annotatorIds.length && !annotatorIds.includes(assigneeId)) return null;
    if (task?.status !== 'annotating') return null;
    const active = this.annotationJobs.find((item) => item.datasetId === datasetId && item.assigneeId === assigneeId && ['claimed', 'in_progress'].includes(item.status));
    if (active) return structuredClone(active);
    const job = this.annotationJobs
      .filter((item) => item.datasetId === datasetId && (item.status === 'available' || (item.status === 'rework' && item.assigneeId === assigneeId)))
      .sort((a, b) => (a.status === 'rework' ? -1 : 1) - (b.status === 'rework' ? -1 : 1) || a.sequence - b.sequence)[0];
    if (!job) return null;
    job.status = 'claimed';
    job.assigneeId = assigneeId;
    job.claimedAt = new Date().toISOString();
    return structuredClone(job);
  }
  async submitAnnotationJob(id: string, assigneeId: string) { const job = this.annotationJobs.find((item) => item.id === id); if (!job || job.assigneeId !== assigneeId || !['claimed', 'in_progress', 'rework'].includes(job.status)) return null; const submittedAt = new Date().toISOString(); for (const image of this.segmentImages(job.segmentId)) { const key = `${job.datasetId}:${image.id}`; const document = this.annotations.get(key); if (document) { document.reviewStatus = 'submitted'; document.submittedAt = submittedAt; document.submittedBy = assigneeId; delete document.reviewedAt; delete document.reviewedBy; delete document.reviewComment; } else { this.annotations.set(key, { datasetId: job.datasetId, imageId: image.id, revision: 0, annotations: [], captions: [], imageAttributes: emptyImageAttributes, updatedAt: submittedAt, updatedBy: assigneeId, reviewStatus: 'submitted', submittedAt, submittedBy: assigneeId }); } } job.status = 'submitted'; job.submittedAt = submittedAt; this.refreshDatasetReviewState(job.datasetId); return structuredClone(job); }
  async updateAnnotationJob(id: string, input: { status?: AnnotationJobStatus; assigneeId?: string | null; reviewComment?: string }) { const job = this.annotationJobs.find((item) => item.id === id); if (!job) return null; if (input.status) job.status = input.status; if (input.assigneeId !== undefined) { if (input.assigneeId === null) delete job.assigneeId; else job.assigneeId = input.assigneeId; } if (input.reviewComment !== undefined) job.reviewComment = input.reviewComment; if (input.status === 'submitted') job.submittedAt = new Date().toISOString(); if (input.status === 'approved' || input.status === 'rework') job.reviewedAt = new Date().toISOString(); return structuredClone(job); }
  async releaseAnnotationJob(id: string, assigneeId: string, force: boolean) { const job = this.annotationJobs.find((item) => item.id === id); if (!job || !['claimed', 'in_progress'].includes(job.status) || (!force && job.assigneeId !== assigneeId)) return null; job.status = 'available'; delete job.assigneeId; delete job.claimedAt; return structuredClone(job); }
  async reassignAnnotationJob(id: string, assigneeId: string) { const job = this.annotationJobs.find((item) => item.id === id); if (!job || !['available', 'claimed', 'in_progress', 'rework'].includes(job.status)) return null; job.status = 'claimed'; job.assigneeId = assigneeId; job.claimedAt = new Date().toISOString(); return structuredClone(job); }
  async reviewAnnotationJobs(ids: string[], reviewerId: string, decision: 'approve' | 'reject', comment?: string) { if (decision === 'reject' && !comment) throw new RepositoryStateError('REVIEW_COMMENT_REQUIRED', '批量驳回必须填写原因'); const uniqueIds = [...new Set(ids)]; const jobs = uniqueIds.map((id) => this.annotationJobs.find((job) => job.id === id)); if (jobs.some((job) => !job || job.status !== 'reviewing' || job.reviewerId !== reviewerId)) throw new RepositoryStateError('ANNOTATION_JOB_REVIEW_LOCKED', '批量审核包含未由当前审核员锁定的 Job'); const results: AnnotationJob[] = []; for (const id of uniqueIds) { const job = await this.reviewAnnotationJob(id, reviewerId, decision, comment); if (job) results.push(job); } return results; }
  async reopenAnnotationJob(id: string, _adminId: string, reason: string) { if (!reason.trim()) throw new RepositoryStateError('REOPEN_REASON_REQUIRED', '重新开放 Job 必须填写原因'); const job = this.annotationJobs.find((item) => item.id === id); if (!job || job.status !== 'approved') return null; job.status = 'rework'; delete job.reviewerId; job.reviewComment = `管理员重新开放：${reason}`; for (const image of this.segmentImages(job.segmentId)) { const document = this.annotations.get(`${job.datasetId}:${image.id}`); if (document) document.reviewStatus = 'rejected'; } this.refreshDatasetReviewState(job.datasetId); return structuredClone(job); }
  private segmentImages(segmentId: string) { const segment = this.annotationSegments.find((item) => item.id === segmentId); if (!segment) return []; const images = (this.datasetImages.get(segment.datasetId) ?? []).filter((image) => segment.sourceAssetId === undefined ? this.assets.find((asset) => asset.id === image.sourceAssetId)?.type !== 'video' : !image.sourceAssetId || image.sourceAssetId === segment.sourceAssetId).sort((a, b) => (a.extractionOrder ?? 0) - (b.extractionOrder ?? 0) || a.createdAt.localeCompare(b.createdAt)); const start = images.findIndex((image) => image.id === segment.startItemId); return start < 0 ? images.filter((image) => image.id === segment.startItemId) : images.slice(start, start + segment.itemCount); }
  private syncAnnotationJobsFromDocuments(datasetId: string, reviewerId?: string) {
    const reviewedAt = new Date().toISOString();
    for (const job of this.annotationJobs.filter((item) => item.datasetId === datasetId)) {
      const documents = this.segmentImages(job.segmentId).map((image) => this.annotations.get(`${datasetId}:${image.id}`));
      if (!documents.length || documents.some((document) => !document)) continue;
      if (documents.every((document) => document?.reviewStatus === 'approved')) {
        job.status = 'approved';
        job.reviewerId = reviewerId ?? job.reviewerId;
        job.reviewedAt = reviewedAt;
      } else if (documents.some((document) => document?.reviewStatus === 'rejected')) {
        job.status = 'rework';
        delete job.reviewerId;
        job.reviewedAt = reviewedAt;
      } else if (documents.every((document) => document?.reviewStatus === 'submitted' || document?.reviewStatus === 'approved') && job.status !== 'reviewing') {
        job.status = 'submitted';
        job.submittedAt ??= reviewedAt;
      }
    }
  }
  async listDatasets() { return structuredClone(this.datasets); }
  async getDataset(id: string) { return structuredClone(this.datasets.find((dataset) => dataset.id === id) ?? null); }
  async createDataset(input: { name: string; description: string; version: string; classes: string[]; labels?: DatasetLabel[]; annotatorIds?: string[]; reviewerIds?: string[]; processingConfig?: DatasetProcessingConfig }) {
    const labels = input.labels?.length ? structuredClone(input.labels) : undefined;
    const dataset: Dataset = { id: `dataset-${randomUUID()}`, ...input, classes: labels ? labels.map((label) => label.name) : input.classes, labels, processingConfig: input.processingConfig ?? { segmentSize: 100, extractionStrategy: 'frame_step', frameStep: 1, imageQuality: 95, overlapSize: 0, useZipBlocks: false, zOrder: false }, annotatorIds: [...new Set(input.annotatorIds ?? [])], reviewerIds: [...new Set(input.reviewerIds ?? [])], images: 0, annotated: 0, size: '0 B', status: '标注中', updatedAt: new Date().toISOString() };
    this.datasets.unshift(dataset);
    await this.createAnnotationTask(dataset.id);
    return structuredClone(dataset);
  }
  async updateDatasetClasses(id: string, classes: string[]) {
    const dataset = this.datasets.find((item) => item.id === id);
    if (!dataset) return null;
    dataset.classes = [...new Set(classes)];
    dataset.updatedAt = new Date().toISOString();
    return structuredClone(dataset);
  }
  async updateDatasetLabels(id: string, labels: DatasetLabel[]) { const dataset = this.datasets.find((item) => item.id === id); if (!dataset) return null; dataset.labels = structuredClone(labels); dataset.classes = labels.map((label) => label.name); dataset.updatedAt = new Date().toISOString(); return structuredClone(dataset); }
  async getDatasetDeletionPlan(id: string) {
    const dataset = this.datasets.find((item) => item.id === id);
    if (!dataset) return null;
    return structuredClone({ dataset, exports: this.exports.filter((task) => task.datasetId === id) });
  }
  async getDatasetDeletionPreview(id: string) {
    const dataset = this.datasets.find((item) => item.id === id);
    if (!dataset) return null;
    const assets = this.assets.filter((item) => item.datasetId === id);
    const images = this.datasetImages.get(id) ?? [];
    const annotations = [...this.annotations.values()].filter((item) => item.datasetId === id);
    const segments = this.annotationSegments.filter((item) => item.datasetId === id);
    const jobs = this.annotationJobs.filter((item) => item.datasetId === id);
    const exports = this.exports.filter((item) => item.datasetId === id);
    const trainingJobs = this.jobs.filter((item) => item.config?.datasetId === id);
    const models = this.models.filter((item) => trainingJobs.some((job) => job.id === item.sourceJob));
    return { resourceId: id, counts: { assets: assets.length, images: images.length, annotations: annotations.length, segments: segments.length, jobs: jobs.length, exports: exports.length, trainingJobs: trainingJobs.length, models: models.length }, releasedBytes: assets.reduce((total, asset) => total + asset.sizeBytes, 0) + images.reduce((total, image) => total + image.sizeBytes, 0) };
  }
  async deleteDataset(id: string) {
    const index = this.datasets.findIndex((item) => item.id === id);
    if (index < 0) return false;
    this.datasets.splice(index, 1);
    this.datasetImages.delete(id);
    for (let index = this.annotationTasks.length - 1; index >= 0; index -= 1) if (this.annotationTasks[index].datasetId === id) this.annotationTasks.splice(index, 1);
    for (let index = this.processingRuns.length - 1; index >= 0; index -= 1) if (this.processingRuns[index].datasetId === id) this.processingRuns.splice(index, 1);
    for (let index = this.annotationSegments.length - 1; index >= 0; index -= 1) if (this.annotationSegments[index].datasetId === id) this.annotationSegments.splice(index, 1);
    for (let index = this.annotationJobs.length - 1; index >= 0; index -= 1) if (this.annotationJobs[index].datasetId === id) this.annotationJobs.splice(index, 1);
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
    dataset.annotated = documents.filter((document) => annotationDocumentHasContent(document) || ['submitted', 'approved'].includes(document.reviewStatus)).length;
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

  async saveAnnotations(input: SaveAnnotationsInput) {
    const key = `${input.datasetId}:${input.imageId}`;
    const current = this.annotations.get(key);
    if ((current?.revision ?? 0) !== input.revision) throw new RepositoryConflictError();
    const reviewJob = input.reviewJobId ? this.annotationJobs.find((job) => job.id === input.reviewJobId) : undefined;
    if (input.reviewJobId && (!reviewJob || reviewJob.status !== 'reviewing' || reviewJob.reviewerId !== input.reviewerId)) throw new RepositoryStateError('ANNOTATION_JOB_REVIEW_LOCKED', '当前审核员未锁定该 Job');
    if (current && ['submitted', 'approved'].includes(current.reviewStatus) && !reviewJob) throw new RepositoryStateError('ANNOTATION_REVIEW_LOCKED', '标注已进入审核完成流程，当前不能修改');
    const captions = structuredClone(input.captions ?? current?.captions ?? []);
    const imageAttributes = structuredClone(input.imageAttributes ?? current?.imageAttributes ?? emptyImageAttributes);
    if (imageAttributes.includeInSdxl && !captions.some((caption) => caption.primary && caption.text.trim())) throw new RepositoryStateError('SDXL_CAPTION_REQUIRED', '纳入 SDXL 训练的图片必须填写主 Caption');
    const updatedAt = new Date().toISOString();
    const annotations = attributeAnnotations(current?.annotations ?? [], input.annotations, { id: input.updatedBy, role: input.updatedByRole ?? (reviewJob ? 'reviewer' : 'annotator') }, updatedAt);
    const document: AnnotationDocument = { datasetId: input.datasetId, imageId: input.imageId, revision: input.revision + 1, annotations, captions, imageAttributes, updatedAt, updatedBy: input.updatedBy, reviewStatus: reviewJob ? current?.reviewStatus ?? 'submitted' : 'draft' };
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
    this.syncAnnotationJobsFromDocuments(datasetId);
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
    this.syncAnnotationJobsFromDocuments(datasetId, input.reviewedBy);
    this.refreshDatasetReviewState(datasetId);
    return structuredClone(this.buildAnnotationReviewSummary(datasetId));
  }

  async listTrainingJobs() { return structuredClone(this.jobs); }
  async getTrainingJob(id: string) { return structuredClone(this.jobs.find((job) => job.id === id) ?? null); }
  async listTrainingEvents(jobId: string) { return structuredClone(this.trainingEvents.filter((event) => event.jobId === jobId)); }
  async getTrainingObservability(jobId: string) { return structuredClone({ metrics: this.trainingMetrics.filter((point) => point.jobId === jobId), resources: this.trainingResources.filter((sample) => sample.jobId === jobId) }); }
  async createTrainingSnapshot(input: { datasetId: string; jobIds?: string[]; createdBy: string }) {
    const dataset = this.datasets.find((item) => item.id === input.datasetId);
    const jobs = this.annotationJobs.filter((job) => job.datasetId === input.datasetId && (!input.jobIds?.length || input.jobIds.includes(job.id)));
    if (input.jobIds?.length && (jobs.length !== input.jobIds.length || jobs.some((job) => job.status !== 'approved'))) throw new RepositoryStateError('TRAINING_APPROVED_JOBS_REQUIRED', '训练只能选择审核通过的 Job');
    const selected = jobs.filter((job) => job.status === 'approved');
    let images = selected.flatMap((job) => this.segmentImages(job.segmentId)).map((image) => ({ ...image }));
    const legacy = !selected.length && !input.jobIds?.length && jobs.length === 0 && dataset?.status === '可训练';
    if (legacy) images = (this.datasetImages.get(input.datasetId) ?? []).map((image) => ({ ...image }));
    if (!images.length && !legacy) throw new RepositoryStateError('TRAINING_APPROVED_JOBS_REQUIRED', '没有可用于训练的审核通过 Job');
    validateTrainingSplitIntegrity(images);
    const documents = images.map((image) => this.annotations.get(`${input.datasetId}:${image.id}`));
    if (!legacy && documents.some((document) => document && document.reviewStatus !== 'approved')) throw new RepositoryStateError('TRAINING_APPROVED_JOBS_REQUIRED', '存在未审核通过的标注');
    const snapshotDocuments = legacy ? documents.filter((document): document is AnnotationDocument => Boolean(document)).map((document) => structuredClone(document)) : images.map((image, index) => structuredClone(documents[index] ?? approvedEmptyAnnotationDocument(input.datasetId, image.id)));
    const processingRunIds = [...new Set(images.map((image) => image.processingRunId).filter((id): id is string => Boolean(id)))];
    const snapshot: TrainingSnapshot = { id: `snapshot-${randomUUID()}`, datasetId: input.datasetId, jobIds: selected.map((job) => job.id), createdAt: new Date().toISOString(), classes: [...(dataset?.classes ?? [])], processingRunIds, processingConfig: { imageCount: images.length, splitCounts: { train: images.filter((image) => image.split === 'train').length, validation: images.filter((image) => image.split === 'validation').length, test: images.filter((image) => image.split === 'test').length } }, images: structuredClone(images), documents: snapshotDocuments };
    this.trainingSnapshots.set(snapshot.id, snapshot);
    return structuredClone(snapshot);
  }
  async getTrainingSnapshot(id: string) { return structuredClone(this.trainingSnapshots.get(id) ?? null); }
  async createTrainingJob(input: { draft: TrainingDraft; datasetName: string; createdBy: string; retrySourceId?: string; snapshotId?: string }) { const job = { ...newTrainingJob(input), config: structuredClone(input.draft), snapshotId: input.snapshotId }; this.jobs.unshift(job); this.trainingEvents.push({ id: String(this.trainingEvents.length + 1), jobId: job.id, level: 'info', message: input.retrySourceId ? `由失败任务 ${input.retrySourceId} 重新创建并进入资源队列` : '训练任务已创建并进入资源队列', createdAt: new Date().toISOString() }); return structuredClone(job); }
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
  async createExport(input: { datasetId: string; format: ExportTask['format']; scope: NonNullable<ExportTask['scope']>; versionName: string; includeImages: boolean; createdBy: string }) { const task: ExportTask = { id: `export-${randomUUID()}`, datasetId: input.datasetId, format: input.format, scope: input.scope, versionName: input.versionName, includeImages: input.includeImages, status: 'queued', progress: 0, createdAt: new Date().toISOString() }; this.exports.unshift(task); return structuredClone(task); }
  async listExports(datasetId: string) { return structuredClone(this.exports.filter((task) => task.datasetId === datasetId)); }
  async getExport(id: string) { return structuredClone(this.exports.find((task) => task.id === id) ?? null); }
  async getArtifact(id: string): Promise<Artifact | null> { return structuredClone(this.artifacts.get(id) ?? null); }
  async getAnnotationStatistics(datasetId: string | undefined, actor: Pick<AuthUser, 'id' | 'role'>): Promise<AnnotationStatistics> {
    const datasetIds = new Set(this.datasets.filter((dataset) => !datasetId || dataset.id === datasetId).map((dataset) => dataset.id));
    const documents = [...this.annotations.values()].filter((document) => datasetIds.has(document.datasetId));
    const scopedDocuments = actor.role === 'annotator' ? documents.filter((document) => document.annotations.some((record) => record.createdBy === actor.id)) : documents;
    const jobs = this.annotationJobs.filter((job) => datasetIds.has(job.datasetId) && (actor.role !== 'annotator' || job.assigneeId === actor.id));
    const reviewerChanges = this.auditLogs.filter((activity) => activity.action === 'annotation_job.review_save' && datasetIds.has(String(activity.metadata.datasetId ?? '')) && (actor.role !== 'reviewer' || activity.actor?.id === actor.id));
    const count = (key: 'added' | 'modified' | 'deleted') => reviewerChanges.reduce((total, activity) => total + Number((activity.metadata.counts as Record<string, unknown> | undefined)?.[key] ?? 0), 0);
    return {
      datasetId,
      annotatorCreatedObjects: scopedDocuments.reduce((total, document) => total + document.annotations.filter((record) => record.createdByRole === 'annotator' && (actor.role !== 'annotator' || record.createdBy === actor.id)).length, 0),
      finalEffectiveObjects: scopedDocuments.reduce((total, document) => total + document.annotations.length, 0),
      completedFrames: scopedDocuments.filter((document) => document.reviewStatus === 'approved').length,
      completedJobs: jobs.filter((job) => ['submitted', 'reviewing', 'approved'].includes(job.status)).length,
      reviewerAddedObjects: count('added'),
      reviewerModifiedObjects: count('modified'),
      reviewerDeletedObjects: count('deleted'),
      approvedJobs: jobs.filter((job) => job.status === 'approved').length,
      rejectedJobs: jobs.filter((job) => job.status === 'rework').length,
    };
  }
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
  const role = row.role as UserRole;
  return { id: String(row.id), workspaceId: String(row.workspace_id), username: String(row.username), displayName: String(row.display_name), role, roles: [role], enabled: row.enabled === undefined ? true : Boolean(row.enabled), mustChangePassword: Boolean(row.must_change_password), passwordHash: String(row.password_hash) };
}

function mapDataset(row: Record<string, unknown>): Dataset {
  return { id: String(row.id), name: String(row.name), description: String(row.description), version: String(row.version), legacyType: row.type ? row.type as Dataset['legacyType'] : undefined, images: Number(row.images), annotated: Number(row.annotated), classes: (row.classes as string[]) ?? [], labels: Array.isArray(row.label_schema) ? row.label_schema as Dataset['labels'] : [], annotatorIds: Array.isArray(row.annotator_ids) ? row.annotator_ids as string[] : [], reviewerIds: Array.isArray(row.reviewer_ids) ? row.reviewer_ids as string[] : [], processingConfig: row.processing_config && typeof row.processing_config === 'object' ? row.processing_config as unknown as DatasetProcessingConfig : { segmentSize: 100, extractionStrategy: 'frame_step', frameStep: 1, imageQuality: 95, overlapSize: 0, useZipBlocks: false, zOrder: false }, updatedAt: displayDate(row.updated_at as string | Date), size: String(row.size), status: row.status as Dataset['status'] };
}

function mapDatasetImage(row: Record<string, unknown>): DatasetImage & { objectKey: string } {
  return {
    id: String(row.id),
    datasetId: String(row.dataset_id),
    objectKey: String(row.object_key),
    filename: String(row.filename),
    mimeType: String(row.mime_type),
    sizeBytes: Number(row.size_bytes),
    sourceAssetId: row.source_asset_id ? String(row.source_asset_id) : undefined,
    sourceRelativePath: row.source_relative_path ? String(row.source_relative_path) : undefined,
    sourceFrameNumber: row.source_frame_number === null || row.source_frame_number === undefined ? undefined : Number(row.source_frame_number),
    sourceTimestampMs: row.source_timestamp_ms === null || row.source_timestamp_ms === undefined ? undefined : Number(row.source_timestamp_ms),
    extractionOrder: row.extraction_order === null || row.extraction_order === undefined ? undefined : Number(row.extraction_order),
    thumbnailObjectKey: row.thumbnail_object_key ? String(row.thumbnail_object_key) : undefined,
    processingRunId: row.processing_run_id ? String(row.processing_run_id) : undefined,
    width: row.width === null ? undefined : Number(row.width),
    height: row.height === null ? undefined : Number(row.height),
    split: row.split as DatasetImage['split'],
    createdAt: displayDate(row.created_at as string | Date),
  };
}

function mapSourceAsset(row: Record<string, unknown>): SourceAsset { return { id: String(row.id), datasetId: String(row.dataset_id), type: row.type as SourceAsset['type'], filename: String(row.filename), mimeType: String(row.mime_type), sizeBytes: Number(row.size_bytes), sha256: row.sha256 ? String(row.sha256) : undefined, objectKey: row.object_key ? String(row.object_key) : undefined, relativePath: row.relative_path ? String(row.relative_path) : undefined, uploadStatus: row.upload_status as SourceAsset['uploadStatus'], processingStatus: row.processing_status as SourceAsset['processingStatus'], processingError: row.processing_error ? String(row.processing_error) : undefined, createdAt: displayDate(row.created_at as string | Date) }; }
function mapUploadSession(row: Record<string, unknown>): UploadSession { return { id: String(row.id), datasetId: String(row.dataset_id), assetId: String(row.asset_id), filename: String(row.filename), mimeType: String(row.mime_type), sizeBytes: Number(row.size_bytes), partSize: Number(row.part_size), totalParts: Number(row.total_parts), completedParts: Array.isArray(row.completed_parts) ? row.completed_parts.map(Number) : [], status: row.status as UploadSession['status'], createdAt: displayDate(row.created_at as string | Date), expiresAt: displayDate(row.expires_at as string | Date) }; }
function mapAnnotationTask(row: Record<string, unknown>): AnnotationTask { return { id: String(row.id), datasetId: String(row.dataset_id), name: String(row.name), status: row.status as AnnotationTask['status'], createdAt: displayDate(row.created_at as string | Date) }; }
function mapProcessingRun(row: Record<string, unknown>): ProcessingRun { return { id: String(row.id), datasetId: String(row.dataset_id), sourceAssetId: row.source_asset_id ? String(row.source_asset_id) : undefined, status: row.status as ProcessingRun['status'], progress: Number(row.progress), extractionStrategy: 'frame_step', frameStep: Number(row.frame_step ?? 1), startFrame: row.start_frame === null || row.start_frame === undefined ? undefined : Number(row.start_frame), endFrame: row.end_frame === null || row.end_frame === undefined ? undefined : Number(row.end_frame), segmentSize: Number(row.segment_size ?? 100), imageQuality: Number(row.image_quality ?? 95), overlapSize: Number(row.overlap_size ?? 0), blockSize: row.block_size === null || row.block_size === undefined ? undefined : Number(row.block_size), useZipBlocks: Boolean(row.use_zip_blocks), zOrder: Boolean(row.z_order), errorMessage: row.error_message ? String(row.error_message) : undefined, createdAt: displayDate(row.created_at as string | Date), updatedAt: displayDate(row.updated_at as string | Date) }; }
function mapAnnotationSegment(row: Record<string, unknown>): AnnotationSegment { return { id: String(row.id), datasetId: String(row.dataset_id), annotationTaskId: String(row.annotation_task_id), sourceAssetId: row.source_asset_id ? String(row.source_asset_id) : undefined, sequence: Number(row.sequence), startItemId: String(row.start_item_id), endItemId: String(row.end_item_id), itemCount: Number(row.item_count), createdAt: displayDate(row.created_at as string | Date) }; }
function mapAnnotationJob(row: Record<string, unknown>): AnnotationJob { return { id: String(row.id), datasetId: String(row.dataset_id), annotationTaskId: String(row.annotation_task_id), segmentId: String(row.segment_id), sequence: Number(row.sequence), status: row.status as AnnotationJob['status'], assigneeId: row.assignee_id ? String(row.assignee_id) : undefined, claimedAt: row.claimed_at ? displayDate(row.claimed_at as string | Date) : undefined, submittedAt: row.submitted_at ? displayDate(row.submitted_at as string | Date) : undefined, reviewedAt: row.reviewed_at ? displayDate(row.reviewed_at as string | Date) : undefined, reviewerId: row.reviewer_id ? String(row.reviewer_id) : undefined, reviewComment: row.review_comment ? String(row.review_comment) : undefined, createdAt: displayDate(row.created_at as string | Date) }; }

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
  return { id: String(row.id), name: String(row.name), type: row.type as TrainingJob['type'], model: String(row.model), dataset: String(row.dataset), status: row.status as TrainingJob['status'], progress: Number(row.progress), epoch: String(row.epoch), metricName: String(row.metric_name), metricValue: String(row.metric_value), gpu: String(row.gpu), createdAt: displayDate(row.created_at as string | Date), eta: String(row.eta), createdBy: row.created_by ? String(row.created_by) : undefined, errorMessage: row.error_message ? String(row.error_message) : undefined, config: row.config as TrainingDraft | undefined, artifactId: row.artifact_id ? String(row.artifact_id) : undefined, snapshotId: row.snapshot_id ? String(row.snapshot_id) : undefined };
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
    jobIds: Array.isArray(row.job_ids) ? row.job_ids.map(String) : undefined,
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
    snapshotId: row.snapshot_id ? String(row.snapshot_id) : undefined,
  };
}

function validateTrainingSplitIntegrity(images: Array<DatasetImage & { objectKey: string }>) {
  const splitsByAsset = new Map<string, Set<DatasetImage['split']>>();
  for (const image of images) {
    if (!image.sourceAssetId) continue;
    const splits = splitsByAsset.get(image.sourceAssetId) ?? new Set<DatasetImage['split']>();
    splits.add(image.split);
    splitsByAsset.set(image.sourceAssetId, splits);
  }
  if ([...splitsByAsset.values()].some((splits) => splits.size > 1)) throw new RepositoryStateError('TRAINING_SPLIT_INTEGRITY', '同一视频的所有 Segment 必须属于同一数据集划分');
}

export class PgRepository implements Repository {
  constructor(private readonly pool: Pool) {}
  async close() { await this.pool.end(); }
  private async one<T extends Record<string, unknown>>(text: string, values: unknown[], client: PoolClient | Pool = this.pool) { const result = await client.query<T>(text, values); return result.rows[0] ?? null; }
  private async refreshDatasetReviewState(datasetId: string, client: PoolClient | Pool = this.pool) {
    const totals = await this.one<{ total: string; annotated: string; approved: string; submitted: string }>(`
      SELECT COUNT(i.id)::text AS total,
             COUNT(d.image_id) FILTER (WHERE d.review_status IN ('submitted', 'approved') OR jsonb_array_length(d.annotations) > 0 OR jsonb_array_length(d.captions) > 0 OR jsonb_array_length(COALESCE(d.image_attributes->'tags', '[]'::jsonb)) > 0)::text AS annotated,
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
    await client.query('UPDATE datasets SET annotated = $2, status = $3, updated_at = CASE WHEN annotated IS DISTINCT FROM $2 OR status IS DISTINCT FROM $3 THEN NOW() ELSE updated_at END WHERE id = $1', [datasetId, Number(totals?.annotated ?? 0), status]);
  }
  private async refreshAllDatasetReviewStates(client: PoolClient | Pool = this.pool) {
    await client.query(`
      WITH totals AS (
        SELECT i.dataset_id,
               COUNT(i.id)::integer AS total,
               COUNT(d.image_id) FILTER (WHERE d.review_status IN ('submitted', 'approved') OR jsonb_array_length(d.annotations) > 0 OR jsonb_array_length(d.captions) > 0 OR jsonb_array_length(COALESCE(d.image_attributes->'tags', '[]'::jsonb)) > 0)::integer AS annotated,
               COUNT(d.image_id) FILTER (WHERE d.review_status = 'approved')::integer AS approved,
               COUNT(d.image_id) FILTER (WHERE d.review_status = 'submitted')::integer AS submitted
        FROM dataset_images i
        LEFT JOIN annotation_documents d ON d.dataset_id = i.dataset_id AND d.image_id = i.id
        GROUP BY i.dataset_id
      ), calculated AS (
        SELECT dataset_id,
               annotated,
               CASE WHEN total > 0 AND approved = total THEN '可训练' ELSE CASE WHEN submitted > 0 THEN '待审核' ELSE '标注中' END END AS status
        FROM totals
      )
      UPDATE datasets d
      SET annotated = calculated.annotated,
          status = calculated.status,
          updated_at = CASE WHEN d.annotated IS DISTINCT FROM calculated.annotated OR d.status IS DISTINCT FROM calculated.status THEN NOW() ELSE d.updated_at END
      FROM calculated
      WHERE d.id = calculated.dataset_id
    `);
  }
  private async syncAnnotationJobsFromDocuments(datasetId: string, reviewerId: string | null, client: PoolClient | Pool = this.pool) {
    await client.query(`
      WITH states AS (
        SELECT j.id,
               COUNT(i.id)::integer AS total,
               COUNT(d.image_id) FILTER (WHERE d.review_status = 'submitted')::integer AS submitted,
               COUNT(d.image_id) FILTER (WHERE d.review_status = 'approved')::integer AS approved,
               COUNT(d.image_id) FILTER (WHERE d.review_status = 'rejected')::integer AS rejected
        FROM annotation_jobs j
        JOIN annotation_segments s ON s.id = j.segment_id
        JOIN dataset_images i ON i.dataset_id = s.dataset_id
          AND (s.source_asset_id IS NULL OR i.source_asset_id = s.source_asset_id)
          AND (s.source_asset_id IS NOT NULL OR EXISTS (SELECT 1 FROM source_assets segment_asset WHERE segment_asset.id = i.source_asset_id AND segment_asset.type::text <> $$video$$))
          AND (i.id IN (s.start_item_id, s.end_item_id)
            OR (i.extraction_order IS NOT NULL AND i.extraction_order BETWEEN
              (SELECT extraction_order FROM dataset_images WHERE id = s.start_item_id)
              AND (SELECT extraction_order FROM dataset_images WHERE id = s.end_item_id)))
        LEFT JOIN annotation_documents d ON d.dataset_id = i.dataset_id AND d.image_id = i.id
        WHERE j.dataset_id = $1
        GROUP BY j.id
      )
      UPDATE annotation_jobs j
      SET status = CASE
            WHEN states.total > 0 AND states.approved = states.total THEN 'approved'
            WHEN states.rejected > 0 THEN 'rework'
            WHEN states.total > 0 AND states.approved + states.submitted = states.total AND j.status <> 'reviewing' THEN 'submitted'
            ELSE j.status
          END,
          reviewer_id = CASE
            WHEN states.total > 0 AND states.approved = states.total THEN COALESCE($2::text, j.reviewer_id)
            WHEN states.rejected > 0 OR (states.total > 0 AND states.approved + states.submitted = states.total AND j.status <> 'reviewing') THEN NULL
            ELSE j.reviewer_id
          END,
          submitted_at = CASE WHEN states.total > 0 AND states.approved + states.submitted = states.total THEN COALESCE(j.submitted_at, NOW()) ELSE j.submitted_at END,
          reviewed_at = CASE WHEN (states.total > 0 AND states.approved = states.total) OR states.rejected > 0 THEN NOW() ELSE j.reviewed_at END
      FROM states
      WHERE j.id = states.id
    `, [datasetId, reviewerId]);
  }
  async findUserByUsername(username: string) { const row = await this.one(`${this.userSelect} WHERE u.username = $1`, [username]); return row ? mapUser(row) : null; }
  async findUserById(id: string) { const row = await this.one(`${this.userSelect} WHERE u.id = $1`, [id]); return row ? mapUser(row) : null; }
  async listDatasetAssets(datasetId: string) { const result = await this.pool.query('SELECT * FROM source_assets WHERE dataset_id = $1 ORDER BY created_at, id', [datasetId]); return result.rows.map(mapSourceAsset); }
  async createSourceAsset(input: { datasetId: string; type: SourceAsset['type']; filename: string; mimeType: string; sizeBytes: number; sha256?: string; objectKey: string }) { const row = await this.one('INSERT INTO source_assets(id, dataset_id, type, filename, mime_type, size_bytes, sha256, object_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *', [`asset-${randomUUID()}`, input.datasetId, input.type, input.filename, input.mimeType, input.sizeBytes, input.sha256 ?? null, input.objectKey]); if (!row) throw new Error('Failed to create source asset'); return mapSourceAsset(row); }
  async markSourceAssetUploaded(id: string, sha256: string) { const row = await this.one("UPDATE source_assets SET upload_status = 'uploaded', sha256 = $2, updated_at = NOW() WHERE id = $1 RETURNING *", [id, sha256]); return row ? mapSourceAsset(row) : null; }
  async createUploadSession(input: { datasetId: string; assetId: string; filename: string; mimeType: string; sizeBytes: number; partSize: number; totalParts: number; expiresAt: string }) { const row = await this.one('INSERT INTO upload_sessions(id, dataset_id, asset_id, filename, mime_type, size_bytes, part_size, total_parts, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *', [`upload-${randomUUID()}`, input.datasetId, input.assetId, input.filename, input.mimeType, input.sizeBytes, input.partSize, input.totalParts, input.expiresAt]); if (!row) throw new Error('Failed to create upload session'); return mapUploadSession(row); }
  async getUploadSession(id: string) { const row = await this.one('SELECT s.*, COALESCE(jsonb_agg(p.part_number ORDER BY p.part_number) FILTER (WHERE p.part_number IS NOT NULL), \'[]\'::jsonb) AS completed_parts FROM upload_sessions s LEFT JOIN upload_parts p ON p.session_id = s.id WHERE s.id = $1 GROUP BY s.id', [id]); return row ? mapUploadSession(row) : null; }
  async listUploadSessions(datasetId: string) { const result = await this.pool.query('SELECT s.*, COALESCE(jsonb_agg(p.part_number ORDER BY p.part_number) FILTER (WHERE p.part_number IS NOT NULL), \'[]\'::jsonb) AS completed_parts FROM upload_sessions s LEFT JOIN upload_parts p ON p.session_id = s.id WHERE s.dataset_id = $1 GROUP BY s.id ORDER BY s.created_at DESC', [datasetId]); return result.rows.map(mapUploadSession); }
  async updateUploadSession(id: string, input: { completedParts?: number[]; status?: UploadStatus; sha256?: string }) { const current = await this.getUploadSession(id); if (!current) return null; if (input.completedParts) for (const part of input.completedParts) await this.pool.query('INSERT INTO upload_parts(session_id, part_number) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, part]); const row = await this.one('UPDATE upload_sessions SET status = COALESCE($2,status), updated_at = NOW() WHERE id = $1 RETURNING *', [id, input.status ?? null]); if (input.status || input.sha256) await this.pool.query('UPDATE source_assets SET upload_status = COALESCE($2,upload_status), sha256 = COALESCE($3,sha256) WHERE id = $1', [current.assetId, input.status ?? null, input.sha256 ?? null]); return row ? this.getUploadSession(id) : null; }
  async cancelUploadSession(id: string) { const result = await this.pool.query("UPDATE upload_sessions SET status = 'cancelled', updated_at = NOW() WHERE id = $1 AND status <> 'uploaded'", [id]); await this.pool.query("UPDATE source_assets SET upload_status = 'cancelled' WHERE id = (SELECT asset_id FROM upload_sessions WHERE id = $1)", [id]); return result.rowCount === 1; }
  async createAnnotationTask(datasetId: string) { const row = await this.one("INSERT INTO annotation_tasks(id, dataset_id, name, status) VALUES ($1,$2,$3,'draft') ON CONFLICT (dataset_id) DO UPDATE SET dataset_id = EXCLUDED.dataset_id RETURNING *", [`annotation-task-${randomUUID()}`, datasetId, '默认标注任务']); if (!row) throw new Error('Failed to create annotation task'); return mapAnnotationTask(row); }
  async getAnnotationTask(datasetId: string) { const row = await this.one('SELECT * FROM annotation_tasks WHERE dataset_id = $1', [datasetId]); return row ? mapAnnotationTask(row) : null; }
  async updateAnnotationTaskStatus(datasetId: string, status: AnnotationTaskStatus) { const row = await this.one('UPDATE annotation_tasks SET status = $2 WHERE dataset_id = $1 RETURNING *', [datasetId, status]); return row ? mapAnnotationTask(row) : null; }
  async createProcessingRun(input: Pick<ProcessingRun, 'datasetId' | 'sourceAssetId' | 'extractionStrategy' | 'frameStep' | 'startFrame' | 'endFrame' | 'segmentSize' | 'imageQuality' | 'overlapSize' | 'blockSize' | 'useZipBlocks' | 'zOrder'>) { const row = await this.one("INSERT INTO processing_runs(id, dataset_id, source_asset_id, status, progress, extraction_strategy, fps, interval_ms, frame_step, start_frame, end_frame, segment_size, image_quality, overlap_size, block_size, use_zip_blocks, z_order) VALUES ($1,$2,$3,'queued',0,'frame_step',NULL,NULL,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *", [`processing-${randomUUID()}`, input.datasetId, input.sourceAssetId ?? null, input.frameStep ?? 1, input.startFrame ?? null, input.endFrame ?? null, input.segmentSize ?? 100, input.imageQuality ?? 95, input.overlapSize ?? 0, input.blockSize ?? null, input.useZipBlocks ?? false, input.zOrder ?? false]); if (!row) throw new Error('Failed to create processing run'); return mapProcessingRun(row); }
  async getProcessingRun(id: string) { const row = await this.one('SELECT * FROM processing_runs WHERE id = $1', [id]); return row ? mapProcessingRun(row) : null; }
  async listProcessingRuns(datasetId: string) { const result = await this.pool.query('SELECT * FROM processing_runs WHERE dataset_id = $1 ORDER BY created_at DESC', [datasetId]); return result.rows.map(mapProcessingRun); }
  async createAnnotationSegments(segments: Array<Omit<AnnotationSegment, 'createdAt'>>) { if (!segments.length) return []; const created: AnnotationSegment[] = []; for (const segment of segments) { const row = await this.one('INSERT INTO annotation_segments(id, dataset_id, annotation_task_id, source_asset_id, sequence, start_item_id, end_item_id, item_count) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *', [segment.id, segment.datasetId, segment.annotationTaskId, segment.sourceAssetId ?? null, segment.sequence, segment.startItemId, segment.endItemId, segment.itemCount]); if (row) created.push(mapAnnotationSegment(row)); } return created; }
  async listAnnotationSegments(datasetId: string) { const result = await this.pool.query('SELECT * FROM annotation_segments WHERE dataset_id = $1 ORDER BY sequence', [datasetId]); return result.rows.map(mapAnnotationSegment); }
  async listAnnotationJobs(datasetId: string) { const result = await this.pool.query('SELECT * FROM annotation_jobs WHERE dataset_id = $1 ORDER BY sequence', [datasetId]); return result.rows.map(mapAnnotationJob); }
  async getAnnotationJob(id: string) { const row = await this.one('SELECT * FROM annotation_jobs WHERE id = $1', [id]); return row ? mapAnnotationJob(row) : null; }
  async submitAnnotationJob(id: string, assigneeId: string) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const job = await this.one("SELECT * FROM annotation_jobs WHERE id = $1 AND assignee_id = $2 AND status IN ('claimed','in_progress','rework') FOR UPDATE", [id, assigneeId], client);
      if (!job) { await client.query('ROLLBACK'); return null; }
      await client.query(`INSERT INTO annotation_documents(dataset_id, image_id, revision, annotations, captions, image_attributes, updated_by, updated_at, review_status, submitted_at, submitted_by)
        SELECT $1, i.id, 0, '[]'::jsonb, '[]'::jsonb, '{"includeInSdxl":false,"tags":[]}'::jsonb, $2, NOW(), 'submitted', NOW(), $2
        FROM dataset_images i JOIN annotation_segments s ON s.id = $3
        WHERE i.dataset_id = s.dataset_id
          AND (s.source_asset_id IS NULL OR i.source_asset_id = s.source_asset_id)
          AND (s.source_asset_id IS NOT NULL OR EXISTS (SELECT 1 FROM source_assets segment_asset WHERE segment_asset.id = i.source_asset_id AND segment_asset.type::text <> $$video$$))
          AND (i.id IN (s.start_item_id, s.end_item_id) OR (i.extraction_order IS NOT NULL AND i.extraction_order BETWEEN (SELECT extraction_order FROM dataset_images WHERE id = s.start_item_id) AND (SELECT extraction_order FROM dataset_images WHERE id = s.end_item_id)))
          AND NOT EXISTS (SELECT 1 FROM annotation_documents existing WHERE existing.dataset_id = $1 AND existing.image_id = i.id)` , [job.dataset_id, assigneeId, job.segment_id]);
      await client.query(`UPDATE annotation_documents d SET review_status = 'submitted', submitted_at = NOW(), submitted_by = $2, reviewed_at = NULL, reviewed_by = NULL, review_comment = NULL WHERE d.dataset_id = $1 AND d.image_id IN (SELECT i.id FROM dataset_images i JOIN annotation_segments s ON s.id = $3 WHERE i.dataset_id = s.dataset_id AND (s.source_asset_id IS NULL OR i.source_asset_id = s.source_asset_id) AND (s.source_asset_id IS NOT NULL OR EXISTS (SELECT 1 FROM source_assets segment_asset WHERE segment_asset.id = i.source_asset_id AND segment_asset.type::text <> $$video$$)) AND (i.id IN (s.start_item_id, s.end_item_id) OR (i.extraction_order IS NOT NULL AND i.extraction_order BETWEEN (SELECT extraction_order FROM dataset_images WHERE id = s.start_item_id) AND (SELECT extraction_order FROM dataset_images WHERE id = s.end_item_id))))`, [job.dataset_id, assigneeId, job.segment_id]);
      const updated = await this.one("UPDATE annotation_jobs SET status = 'submitted', submitted_at = NOW() WHERE id = $1 RETURNING *", [id], client);
      await this.refreshDatasetReviewState(String(job.dataset_id), client);
      await client.query('COMMIT');
      return updated ? mapAnnotationJob(updated) : null;
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  async claimNextAnnotationReviewJob(datasetId: string, reviewerId: string, isAdmin = false) { const client = await this.pool.connect(); try { await client.query('BEGIN'); const row = await this.one("SELECT j.* FROM annotation_jobs j JOIN datasets d ON d.id = j.dataset_id WHERE j.dataset_id = $1 AND j.status = 'submitted' AND (j.assignee_id IS NULL OR j.assignee_id <> $2) AND ($3 OR jsonb_array_length(d.reviewer_ids) = 0 OR d.reviewer_ids @> jsonb_build_array($2::text)) ORDER BY sequence FOR UPDATE SKIP LOCKED LIMIT 1", [datasetId, reviewerId, isAdmin], client); if (!row) { await client.query('COMMIT'); return null; } const updated = await this.one("UPDATE annotation_jobs SET status = 'reviewing', reviewer_id = $2 WHERE id = $1 RETURNING *", [row.id, reviewerId], client); await client.query('COMMIT'); return updated ? mapAnnotationJob(updated) : null; } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); } }
  async claimAnnotationReviewJob(id: string, reviewerId: string, isAdmin = false) { const client = await this.pool.connect(); try { await client.query('BEGIN'); const row = await this.one("SELECT j.* FROM annotation_jobs j JOIN datasets d ON d.id = j.dataset_id WHERE j.id = $1 AND j.status = 'submitted' AND (j.assignee_id IS NULL OR j.assignee_id <> $2) AND ($3 OR jsonb_array_length(d.reviewer_ids) = 0 OR d.reviewer_ids @> jsonb_build_array($2::text)) FOR UPDATE OF j SKIP LOCKED", [id, reviewerId, isAdmin], client); if (!row) { await client.query('COMMIT'); return null; } const updated = await this.one("UPDATE annotation_jobs SET status = 'reviewing', reviewer_id = $2 WHERE id = $1 RETURNING *", [id, reviewerId], client); await client.query('COMMIT'); return updated ? mapAnnotationJob(updated) : null; } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); } }
  async reviewAnnotationJob(id: string, reviewerId: string, decision: 'approve' | 'reject', comment?: string) { if (decision === 'reject' && !comment) throw new RepositoryStateError('REVIEW_COMMENT_REQUIRED', '驳回必须填写原因'); const client = await this.pool.connect(); try { await client.query('BEGIN'); const job = await this.one("SELECT * FROM annotation_jobs WHERE id = $1 AND reviewer_id = $2 AND status = 'reviewing' FOR UPDATE", [id, reviewerId]); if (!job) { await client.query('ROLLBACK'); return null; } const status = decision === 'approve' ? 'approved' : 'rework'; await client.query(`UPDATE annotation_documents d SET review_status = $2, reviewed_at = NOW(), reviewed_by = $3, review_comment = $4 WHERE d.dataset_id = $1 AND d.image_id IN (SELECT i.id FROM dataset_images i JOIN annotation_segments s ON s.id = $5 WHERE i.dataset_id = s.dataset_id AND (s.source_asset_id IS NULL OR i.source_asset_id = s.source_asset_id) AND (s.source_asset_id IS NOT NULL OR EXISTS (SELECT 1 FROM source_assets segment_asset WHERE segment_asset.id = i.source_asset_id AND segment_asset.type::text <> $$video$$)) AND (i.id IN (s.start_item_id, s.end_item_id) OR (i.extraction_order IS NOT NULL AND i.extraction_order BETWEEN (SELECT extraction_order FROM dataset_images WHERE id = s.start_item_id) AND (SELECT extraction_order FROM dataset_images WHERE id = s.end_item_id))))`, [job.dataset_id, decision === 'approve' ? 'approved' : 'rejected', reviewerId, comment ?? null, job.segment_id]); const updated = await this.one("UPDATE annotation_jobs SET status = $2, reviewed_at = NOW(), review_comment = $3, reviewer_id = CASE WHEN $2 = 'rework' THEN NULL ELSE reviewer_id END WHERE id = $1 RETURNING *", [id, status, comment ?? null], client); await this.refreshDatasetReviewState(String(job.dataset_id), client); await client.query('COMMIT'); return updated ? mapAnnotationJob(updated) : null; } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); } }
  async reviewAnnotationJobs(ids: string[], reviewerId: string, decision: 'approve' | 'reject', comment?: string) { if (decision === 'reject' && !comment) throw new RepositoryStateError('REVIEW_COMMENT_REQUIRED', '批量驳回必须填写原因'); const results: AnnotationJob[] = []; for (const id of [...new Set(ids)]) { const job = await this.reviewAnnotationJob(id, reviewerId, decision, comment); if (job) results.push(job); } return results; }
  async reopenAnnotationJob(id: string, _adminId: string, reason: string) { if (!reason.trim()) throw new RepositoryStateError('REOPEN_REASON_REQUIRED', '重新开放 Job 必须填写原因'); const client = await this.pool.connect(); try { await client.query('BEGIN'); const job = await this.one("SELECT * FROM annotation_jobs WHERE id = $1 AND status = 'approved' FOR UPDATE", [id]); if (!job) { await client.query('ROLLBACK'); return null; } await client.query(`UPDATE annotation_documents d SET review_status = 'rejected', review_comment = $2 WHERE d.dataset_id = $1 AND d.image_id IN (SELECT i.id FROM dataset_images i JOIN annotation_segments s ON s.id = $3 WHERE i.dataset_id = s.dataset_id AND (s.source_asset_id IS NULL OR i.source_asset_id = s.source_asset_id) AND (s.source_asset_id IS NOT NULL OR EXISTS (SELECT 1 FROM source_assets segment_asset WHERE segment_asset.id = i.source_asset_id AND segment_asset.type::text <> $$video$$)) AND (i.id IN (s.start_item_id, s.end_item_id) OR (i.extraction_order IS NOT NULL AND i.extraction_order BETWEEN (SELECT extraction_order FROM dataset_images WHERE id = s.start_item_id) AND (SELECT extraction_order FROM dataset_images WHERE id = s.end_item_id))))`, [job.dataset_id, `管理员重新开放：${reason}`, job.segment_id]); const updated = await this.one("UPDATE annotation_jobs SET status = 'rework', reviewer_id = NULL, review_comment = $2 WHERE id = $1 RETURNING *", [id, `管理员重新开放：${reason}`], client); await this.refreshDatasetReviewState(String(job.dataset_id), client); await client.query('COMMIT'); return updated ? mapAnnotationJob(updated) : null; } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); } }
  async claimNextAnnotationJob(datasetId: string, assigneeId: string) { const client = await this.pool.connect(); try { await client.query('BEGIN'); const active = await this.one("SELECT j.* FROM annotation_jobs j JOIN annotation_tasks t ON t.id = j.annotation_task_id WHERE j.dataset_id = $1 AND t.status = 'annotating' AND j.assignee_id = $2 AND j.status IN ('claimed','in_progress') ORDER BY j.sequence FOR UPDATE OF j SKIP LOCKED LIMIT 1", [datasetId, assigneeId], client); if (active) { await client.query('COMMIT'); return mapAnnotationJob(active); } const row = await this.one("SELECT j.* FROM annotation_jobs j JOIN annotation_tasks t ON t.id = j.annotation_task_id JOIN datasets d ON d.id = j.dataset_id WHERE j.dataset_id = $1 AND t.status = 'annotating' AND (j.status = 'available' OR (j.status = 'rework' AND j.assignee_id = $2)) AND (jsonb_array_length(d.annotator_ids) = 0 OR d.annotator_ids @> jsonb_build_array($2::text)) ORDER BY CASE WHEN j.status = 'rework' THEN 0 ELSE 1 END, j.sequence FOR UPDATE OF j SKIP LOCKED LIMIT 1", [datasetId, assigneeId], client); if (!row) { await client.query('COMMIT'); return null; } const updated = await this.one("UPDATE annotation_jobs SET status = 'claimed', assignee_id = $2, claimed_at = NOW() WHERE id = $1 RETURNING *", [row.id, assigneeId], client); await client.query('COMMIT'); return updated ? mapAnnotationJob(updated) : null; } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); } }
  async updateAnnotationJob(id: string, input: { status?: AnnotationJobStatus; assigneeId?: string | null; reviewComment?: string }) { const row = await this.one("UPDATE annotation_jobs SET status = COALESCE($2,status), assignee_id = CASE WHEN $3::text IS NULL AND $2 IN ('available','rework') THEN NULL ELSE COALESCE($3,assignee_id) END, review_comment = COALESCE($4,review_comment), submitted_at = CASE WHEN $2 = 'submitted' THEN NOW() ELSE submitted_at END, reviewed_at = CASE WHEN $2 IN ('approved','rework') THEN NOW() ELSE reviewed_at END WHERE id = $1 RETURNING *", [id, input.status ?? null, input.assigneeId ?? null, input.reviewComment ?? null]); return row ? mapAnnotationJob(row) : null; }
  async releaseAnnotationJob(id: string, assigneeId: string, force: boolean) { const row = await this.one("UPDATE annotation_jobs SET status = 'available', assignee_id = NULL, claimed_at = NULL WHERE id = $1 AND status IN ('claimed','in_progress') AND ($3 OR assignee_id = $2) RETURNING *", [id, assigneeId, force]); return row ? mapAnnotationJob(row) : null; }
  async reassignAnnotationJob(id: string, assigneeId: string) { const row = await this.one("UPDATE annotation_jobs SET status = 'claimed', assignee_id = $2, claimed_at = NOW() WHERE id = $1 AND status IN ('available','claimed','in_progress','rework') RETURNING *", [id, assigneeId]); return row ? mapAnnotationJob(row) : null; }
  private userSelect = `SELECT u.*, jsonb_build_array(u.role) AS roles FROM users u`;
  async listUsers() { const result = await this.pool.query(`${this.userSelect} WHERE u.username <> '__deleted_user__' ORDER BY u.username`); return result.rows.map((row) => { const { passwordHash: _, ...user } = mapUser(row); return user; }); }
  async createUser(input: { username: string; displayName: string; password: string; roles: UserRole[] }) {
    const role = roleAliases[input.roles[0]];
    if (!role) throw new RepositoryStateError('USER_ROLE_REQUIRED', '用户必须绑定一个角色');
    const id = `user-${randomUUID()}`;
    const client = await this.pool.connect();
    let row: Record<string, unknown> | null;
    try {
      await client.query('BEGIN');
      row = await this.one('INSERT INTO users(id, workspace_id, username, display_name, password_hash, role, roles, enabled, must_change_password) VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE,TRUE) RETURNING *', [id, workspaceId, input.username, input.displayName, await bcrypt.hash(input.password, 12), role, JSON.stringify([role])], client);
      await client.query('INSERT INTO user_roles(user_id, role) VALUES ($1, $2)', [id, role]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    if (!row) throw new Error('Failed to create user');
    const { passwordHash: _, ...user } = mapUser({ ...row, role });
    return user;
  }
  async updateUser(id: string, input: { displayName?: string; roles?: UserRole[]; enabled?: boolean; password?: string }) {
    const current = await this.findUserById(id);
    if (!current) return null;
    const role = input.roles ? roleAliases[input.roles[0]] : current.role;
    if (!role) throw new RepositoryStateError('USER_ROLE_REQUIRED', '用户必须绑定一个角色');
    const client = await this.pool.connect();
    let row: Record<string, unknown> | null;
    try {
      await client.query('BEGIN');
      row = await this.one('UPDATE users SET display_name = COALESCE($2, display_name), role = $3, roles = $4, enabled = COALESCE($5, enabled), password_hash = COALESCE($6, password_hash), must_change_password = CASE WHEN $6 IS NULL THEN must_change_password ELSE TRUE END, updated_at = NOW() WHERE id = $1 RETURNING *', [id, input.displayName ?? null, role, JSON.stringify([role]), input.enabled ?? null, input.password ? await bcrypt.hash(input.password, 12) : null], client);
      await client.query('DELETE FROM user_roles WHERE user_id = $1', [id]);
      await client.query('INSERT INTO user_roles(user_id, role) VALUES ($1, $2)', [id, role]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    if (!row) return null;
    const { passwordHash: _, ...user } = mapUser(row);
    return user;
  }
  async deleteUser(id: string) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const deletedUserId = 'system-deleted-user';
      const deletedUserPassword = await bcrypt.hash(randomUUID(), 4);
      await client.query(
        'INSERT INTO users(id, workspace_id, username, display_name, password_hash, role, roles, enabled, must_change_password) VALUES ($1,$2,$3,$4,$5,$6,$7,FALSE,FALSE) ON CONFLICT (id) DO NOTHING',
        [deletedUserId, workspaceId, '__deleted_user__', '已删除用户', deletedUserPassword, 'annotator', JSON.stringify(['annotator'])],
      );
      await client.query("UPDATE datasets SET annotator_ids = COALESCE((SELECT jsonb_agg(value) FROM jsonb_array_elements(annotator_ids) WHERE value <> to_jsonb($1::text)), '[]'::jsonb), reviewer_ids = COALESCE((SELECT jsonb_agg(value) FROM jsonb_array_elements(reviewer_ids) WHERE value <> to_jsonb($1::text)), '[]'::jsonb), updated_at = NOW() WHERE annotator_ids @> jsonb_build_array($1::text) OR reviewer_ids @> jsonb_build_array($1::text)", [id]);
      await client.query('UPDATE annotation_documents SET updated_by = $2, submitted_by = CASE WHEN submitted_by = $1 THEN $2 ELSE submitted_by END, reviewed_by = CASE WHEN reviewed_by = $1 THEN $2 ELSE reviewed_by END WHERE updated_by = $1 OR submitted_by = $1 OR reviewed_by = $1', [id, deletedUserId]);
      await client.query('UPDATE annotation_review_snapshots SET reviewer_id = $2 WHERE reviewer_id = $1', [id, deletedUserId]);
      await client.query('UPDATE training_jobs SET created_by = $2 WHERE created_by = $1', [id, deletedUserId]);
      await client.query('UPDATE conversion_jobs SET created_by = $2 WHERE created_by = $1', [id, deletedUserId]);
      await client.query('UPDATE export_tasks SET created_by = $2 WHERE created_by = $1', [id, deletedUserId]);
      await client.query('UPDATE artifacts SET created_by = $2 WHERE created_by = $1', [id, deletedUserId]);
      await client.query('UPDATE training_snapshots SET created_by = $2 WHERE created_by = $1', [id, deletedUserId]);
      await client.query('UPDATE audit_logs SET actor_id = $2 WHERE actor_id = $1', [id, deletedUserId]);
      const result = await client.query('DELETE FROM users WHERE id = $1 RETURNING id', [id]);
      await client.query('COMMIT');
      return result.rowCount === 1;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }
  async getSettings() { const row = await this.one('SELECT settings FROM system_settings WHERE id = $1', ['default']); return (row?.settings as SystemSettings) ?? { uploadMaxBytes: 512 * 1024 * 1024, defaultImageSegmentSize: 100, defaultVideoSegmentSize: 100, autosaveIntervalSeconds: 5, retentionDays: 30, allowedVideoFormats: ['mp4', 'mov', 'avi', 'mkv'] }; }
  async updateSettings(input: Partial<SystemSettings>) { const settings = { ...(await this.getSettings()), ...input }; await this.pool.query('INSERT INTO system_settings(id, settings, updated_at) VALUES ($1,$2,NOW()) ON CONFLICT (id) DO UPDATE SET settings = EXCLUDED.settings, updated_at = NOW()', ['default', JSON.stringify(settings)]); return settings; }
  async listDatasets() { await this.refreshAllDatasetReviewStates(); const result = await this.pool.query('SELECT * FROM datasets ORDER BY updated_at DESC'); return result.rows.map(mapDataset); }
  async getDataset(id: string) { await this.refreshDatasetReviewState(id); const row = await this.one('SELECT * FROM datasets WHERE id = $1', [id]); return row ? mapDataset(row) : null; }
  async createDataset(input: { name: string; description: string; version: string; classes: string[]; labels?: DatasetLabel[]; annotatorIds?: string[]; reviewerIds?: string[]; processingConfig?: DatasetProcessingConfig }) {
    const id = `dataset-${randomUUID()}`;
    const labels = input.labels?.length ? input.labels : [];
    const classes = labels.length ? labels.map((label) => label.name) : input.classes;
    const row = await this.one('INSERT INTO datasets(id, workspace_id, name, description, version, type, images, annotated, classes, size, status, annotator_ids, reviewer_ids, processing_config, label_schema) VALUES ($1,$2,$3,$4,$5,NULL,0,0,$6,$7,$8,$9,$10,$11,$12) RETURNING *', [id, workspaceId, input.name, input.description, input.version, JSON.stringify([...new Set(classes)]), '0 B', '标注中', JSON.stringify([...new Set(input.annotatorIds ?? [])]), JSON.stringify([...new Set(input.reviewerIds ?? [])]), JSON.stringify(input.processingConfig ?? { segmentSize: 100, extractionStrategy: 'frame_step', frameStep: 1, imageQuality: 95, overlapSize: 0, useZipBlocks: false, zOrder: false }), JSON.stringify(labels)]);
    if (!row) throw new Error('Failed to create dataset');
    const dataset = mapDataset(row);
    await this.createAnnotationTask(dataset.id);
    return dataset;
  }
  async updateDatasetClasses(id: string, classes: string[]) {
    const row = await this.one('UPDATE datasets SET classes = $2, updated_at = NOW() WHERE id = $1 RETURNING *', [id, JSON.stringify([...new Set(classes)])]);
    return row ? mapDataset(row) : null;
  }
  async updateDatasetLabels(id: string, labels: DatasetLabel[]) { const row = await this.one('UPDATE datasets SET label_schema = $2, classes = $3, updated_at = NOW() WHERE id = $1 RETURNING *', [id, JSON.stringify(labels), JSON.stringify(labels.map((label) => label.name))]); return row ? mapDataset(row) : null; }
  async getDatasetDeletionPlan(id: string) {
    const dataset = await this.getDataset(id);
    if (!dataset) return null;
    return { dataset, exports: await this.listExports(id) };
  }
  async getDatasetDeletionPreview(id: string) {
    const dataset = await this.getDataset(id);
    if (!dataset) return null;
    const result = await this.one<{ assets: string; images: string; annotations: string; segments: string; jobs: string; exports: string; training_jobs: string; models: string; released_bytes: string }>(`SELECT
      (SELECT COUNT(*) FROM source_assets WHERE dataset_id = $1) AS assets,
      (SELECT COUNT(*) FROM dataset_images WHERE dataset_id = $1) AS images,
      (SELECT COUNT(*) FROM annotation_documents WHERE dataset_id = $1) AS annotations,
      (SELECT COUNT(*) FROM annotation_segments WHERE dataset_id = $1) AS segments,
      (SELECT COUNT(*) FROM annotation_jobs WHERE dataset_id = $1) AS jobs,
      (SELECT COUNT(*) FROM export_tasks WHERE dataset_id = $1) AS exports,
      (SELECT COUNT(*) FROM training_jobs WHERE config->>'datasetId' = $1) AS training_jobs,
      (SELECT COUNT(*) FROM model_versions m JOIN training_jobs t ON t.id = m.source_job WHERE t.config->>'datasetId' = $1) AS models,
      (SELECT COALESCE(SUM(size_bytes), 0) FROM source_assets WHERE dataset_id = $1) + (SELECT COALESCE(SUM(size_bytes), 0) FROM dataset_images WHERE dataset_id = $1) AS released_bytes`, [id]);
    if (!result) return null;
    return { resourceId: id, counts: { assets: Number(result.assets), images: Number(result.images), annotations: Number(result.annotations), segments: Number(result.segments), jobs: Number(result.jobs), exports: Number(result.exports), trainingJobs: Number(result.training_jobs), models: Number(result.models) }, releasedBytes: Number(result.released_bytes) };
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
  async saveAnnotations(input: SaveAnnotationsInput) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const image = await this.one('SELECT id FROM dataset_images WHERE dataset_id = $1 AND id = $2', [input.datasetId, input.imageId], client);
      if (!image) throw new RepositoryStateError('ANNOTATION_REVIEW_IMAGE_NOT_FOUND', '标注图像不存在');
      const current = await this.one('SELECT * FROM annotation_documents WHERE dataset_id = $1 AND image_id = $2 FOR UPDATE', [input.datasetId, input.imageId], client);
      if (Number(current?.revision ?? 0) !== input.revision) throw new RepositoryConflictError();
      let reviewJob: Record<string, unknown> | null = null;
      if (input.reviewJobId) {
        reviewJob = await this.one("SELECT * FROM annotation_jobs WHERE id = $1 AND status = 'reviewing' AND reviewer_id = $2 FOR UPDATE", [input.reviewJobId, input.reviewerId ?? null], client);
        if (!reviewJob) throw new RepositoryStateError('ANNOTATION_JOB_REVIEW_LOCKED', '当前审核员未锁定该 Job');
      }
      if (current && ['submitted', 'approved'].includes(String(current.review_status)) && !reviewJob) throw new RepositoryStateError('ANNOTATION_REVIEW_LOCKED', '标注已进入审核完成流程，当前不能修改');
      const captions: AnnotationDocument['captions'] = input.captions ?? (current?.captions as AnnotationDocument['captions'] | undefined) ?? [];
      const imageAttributes: AnnotationDocument['imageAttributes'] = input.imageAttributes ?? (current?.image_attributes as AnnotationDocument['imageAttributes'] | undefined) ?? emptyImageAttributes;
      if (imageAttributes.includeInSdxl && !captions.some((caption) => caption.primary && caption.text.trim())) throw new RepositoryStateError('SDXL_CAPTION_REQUIRED', '纳入 SDXL 训练的图片必须填写主 Caption');
      const updatedAt = new Date().toISOString();
      const currentDocument = current ? mapAnnotationDocument(current) : undefined;
      const annotations = attributeAnnotations(currentDocument?.annotations ?? [], input.annotations, { id: input.updatedBy, role: input.updatedByRole ?? (reviewJob ? 'reviewer' : 'annotator') }, updatedAt);
      const reviewStatus = reviewJob ? String(current?.review_status ?? 'submitted') : 'draft';
      const row = await this.one(`
        INSERT INTO annotation_documents(dataset_id, image_id, revision, annotations, captions, image_attributes, updated_by, review_status)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (dataset_id, image_id) DO UPDATE
          SET revision = EXCLUDED.revision, annotations = EXCLUDED.annotations, captions = EXCLUDED.captions,
              image_attributes = EXCLUDED.image_attributes, updated_by = EXCLUDED.updated_by,
              updated_at = NOW(), review_status = EXCLUDED.review_status,
              submitted_at = CASE WHEN EXCLUDED.review_status = 'submitted' THEN annotation_documents.submitted_at ELSE NULL END,
              submitted_by = CASE WHEN EXCLUDED.review_status = 'submitted' THEN annotation_documents.submitted_by ELSE NULL END,
              reviewed_at = CASE WHEN EXCLUDED.review_status = 'submitted' THEN annotation_documents.reviewed_at ELSE NULL END,
              reviewed_by = CASE WHEN EXCLUDED.review_status = 'submitted' THEN annotation_documents.reviewed_by ELSE NULL END,
              review_comment = CASE WHEN EXCLUDED.review_status = 'submitted' THEN annotation_documents.review_comment ELSE NULL END
        RETURNING *
      `, [input.datasetId, input.imageId, input.revision + 1, JSON.stringify(annotations), JSON.stringify(captions), JSON.stringify(imageAttributes), input.updatedBy, reviewStatus], client);
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
      await this.syncAnnotationJobsFromDocuments(datasetId, null, client);
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
      await this.syncAnnotationJobsFromDocuments(datasetId, input.reviewedBy, client);
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
  async createTrainingSnapshot(input: { datasetId: string; jobIds?: string[]; createdBy: string }) {
    const selected = input.jobIds?.length ? input.jobIds : null;
    const jobs = await this.pool.query('SELECT j.id FROM annotation_jobs j WHERE j.dataset_id = $1 AND j.status = \'approved\' AND ($2::text[] IS NULL OR j.id = ANY($2::text[])) ORDER BY j.sequence', [input.datasetId, selected]);
    if (input.jobIds?.length && jobs.rowCount !== input.jobIds.length) throw new RepositoryStateError('TRAINING_APPROVED_JOBS_REQUIRED', '训练只能选择审核通过的 Job');
    const dataset = await this.one<{ classes: string[] }>('SELECT classes FROM datasets WHERE id = $1', [input.datasetId]);
    const snapshotId = `snapshot-${randomUUID()}`;
    const query = jobs.rowCount ? `
      SELECT DISTINCT ON (i.id) i.*,
             d.dataset_id AS annotation_dataset_id,
             d.image_id AS annotation_image_id,
             d.revision AS annotation_revision,
             d.annotations AS annotation_annotations,
             d.captions AS annotation_captions,
             d.image_attributes AS annotation_image_attributes,
             d.updated_at AS annotation_updated_at,
             d.updated_by AS annotation_updated_by,
             d.review_status AS annotation_review_status,
             d.submitted_at AS annotation_submitted_at,
             d.submitted_by AS annotation_submitted_by,
             d.reviewed_at AS annotation_reviewed_at,
             d.reviewed_by AS annotation_reviewed_by,
             d.review_comment AS annotation_review_comment
      FROM dataset_images i
      LEFT JOIN annotation_documents d ON d.dataset_id = i.dataset_id AND d.image_id = i.id
      JOIN annotation_segments s ON s.dataset_id = i.dataset_id
        AND (s.source_asset_id IS NULL OR s.source_asset_id = i.source_asset_id)
        AND (s.source_asset_id IS NOT NULL OR EXISTS (
          SELECT 1 FROM source_assets segment_asset
          WHERE segment_asset.id = i.source_asset_id AND segment_asset.type::text <> $$video$$
        ))
      JOIN annotation_jobs j ON j.segment_id = s.id AND j.id = ANY($2::text[])
      WHERE i.dataset_id = $1
        AND (d.image_id IS NULL OR d.review_status = 'approved')
        AND (i.id IN (s.start_item_id, s.end_item_id) OR (i.extraction_order IS NOT NULL AND i.extraction_order BETWEEN
          (SELECT extraction_order FROM dataset_images WHERE id = s.start_item_id)
          AND (SELECT extraction_order FROM dataset_images WHERE id = s.end_item_id)))
      ORDER BY i.id
    ` : 'SELECT i.* FROM dataset_images i WHERE i.dataset_id = $1 ORDER BY i.id';
    const rows = await this.pool.query(query, jobs.rowCount ? [input.datasetId, jobs.rows.map((row) => row.id)] : [input.datasetId]);
    if (!rows.rowCount && jobs.rowCount) throw new RepositoryStateError('TRAINING_APPROVED_JOBS_REQUIRED', '没有可用于训练的审核通过 Job');
    const images = rows.rows.map(mapDatasetImage);
    const documents = jobs.rowCount ? rows.rows.map((row) => row.annotation_image_id ? mapAnnotationDocument({
      dataset_id: row.annotation_dataset_id,
      image_id: row.annotation_image_id,
      revision: row.annotation_revision,
      annotations: row.annotation_annotations,
      captions: row.annotation_captions,
      image_attributes: row.annotation_image_attributes,
      updated_at: row.annotation_updated_at,
      updated_by: row.annotation_updated_by,
      review_status: row.annotation_review_status,
      submitted_at: row.annotation_submitted_at,
      submitted_by: row.annotation_submitted_by,
      reviewed_at: row.annotation_reviewed_at,
      reviewed_by: row.annotation_reviewed_by,
      review_comment: row.annotation_review_comment,
    }) : approvedEmptyAnnotationDocument(input.datasetId, String(row.id))) : [];
    validateTrainingSplitIntegrity(images);
    const processingRunIds = [...new Set(images.map((image) => image.processingRunId).filter((id): id is string => Boolean(id)))];
    const snapshot: TrainingSnapshot = { id: snapshotId, datasetId: input.datasetId, jobIds: jobs.rows.map((row) => String(row.id)), createdAt: new Date().toISOString(), classes: Array.isArray(dataset?.classes) ? dataset.classes : [], processingRunIds, processingConfig: { imageCount: images.length, splitCounts: { train: images.filter((image) => image.split === 'train').length, validation: images.filter((image) => image.split === 'validation').length, test: images.filter((image) => image.split === 'test').length } }, images, documents };
    await this.pool.query('INSERT INTO training_snapshots(id, workspace_id, dataset_id, job_ids, snapshot, created_by) VALUES ($1,$2,$3,$4,$5,$6)', [snapshotId, workspaceId, input.datasetId, JSON.stringify(snapshot.jobIds), JSON.stringify(snapshot), input.createdBy]);
    return snapshot;
  }
  async getTrainingSnapshot(id: string) { const row = await this.one<{ snapshot: TrainingSnapshot }>('SELECT snapshot FROM training_snapshots WHERE id = $1', [id]); return row?.snapshot ? row.snapshot : null; }
  async createTrainingJob(input: { draft: TrainingDraft; datasetName: string; createdBy: string; retrySourceId?: string; snapshotId?: string }) { const job = newTrainingJob(input); const row = await this.one('INSERT INTO training_jobs(id, workspace_id, name, type, model, dataset, status, progress, epoch, metric_name, metric_value, gpu, eta, created_by, config, snapshot_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *', [job.id, workspaceId, job.name, job.type, job.model, job.dataset, job.status, job.progress, job.epoch, job.metricName, job.metricValue, job.gpu, job.eta, input.createdBy, JSON.stringify(input.draft), input.snapshotId ?? null]); if (!row) throw new Error('Failed to create training job'); const message = input.retrySourceId ? `由失败任务 ${input.retrySourceId} 重新创建并进入资源队列` : '训练任务已创建并进入资源队列'; await this.pool.query('INSERT INTO training_events(workspace_id, job_id, level, message) VALUES ($1,$2,$3,$4)', [workspaceId, job.id, 'info', message]); return mapJob(row); }
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
  async createExport(input: { datasetId: string; format: ExportTask['format']; scope: NonNullable<ExportTask['scope']>; versionName: string; includeImages: boolean; createdBy: string }) { const task: ExportTask = { id: `export-${randomUUID()}`, datasetId: input.datasetId, format: input.format, scope: input.scope, versionName: input.versionName, includeImages: input.includeImages, status: 'queued', progress: 0, createdAt: new Date().toISOString() }; await this.pool.query('INSERT INTO export_tasks(id, workspace_id, dataset_id, format, scope, version_name, include_images, status, progress, created_by, job_ids) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [task.id, workspaceId, task.datasetId, task.format, task.scope, task.versionName, task.includeImages, task.status, task.progress, input.createdBy, JSON.stringify([])]); return task; }
  async listExports(datasetId: string) { const result = await this.pool.query('SELECT * FROM export_tasks WHERE dataset_id = $1 ORDER BY created_at DESC', [datasetId]); return result.rows.map(mapExport); }
  async getExport(id: string) { const row = await this.one('SELECT * FROM export_tasks WHERE id = $1', [id]); return row ? mapExport(row) : null; }
  async getArtifact(id: string) { const row = await this.one('SELECT * FROM artifacts WHERE id = $1', [id]); return row ? mapArtifact(row) : null; }
  async getAnnotationStatistics(datasetId: string | undefined, actor: Pick<AuthUser, 'id' | 'role'>): Promise<AnnotationStatistics> {
    const documents = await this.pool.query<{ annotations: unknown; review_status: string }>(
      datasetId
        ? 'SELECT d.annotations, d.review_status FROM annotation_documents d JOIN datasets ds ON ds.id = d.dataset_id WHERE ds.workspace_id = $1 AND d.dataset_id = $2'
        : 'SELECT d.annotations, d.review_status FROM annotation_documents d JOIN datasets ds ON ds.id = d.dataset_id WHERE ds.workspace_id = $1',
      datasetId ? [workspaceId, datasetId] : [workspaceId],
    );
    const jobs = await this.pool.query<{ status: string; assignee_id: string | null }>(
      datasetId
        ? 'SELECT j.status, j.assignee_id FROM annotation_jobs j JOIN datasets ds ON ds.id = j.dataset_id WHERE ds.workspace_id = $1 AND j.dataset_id = $2'
        : 'SELECT j.status, j.assignee_id FROM annotation_jobs j JOIN datasets ds ON ds.id = j.dataset_id WHERE ds.workspace_id = $1',
      datasetId ? [workspaceId, datasetId] : [workspaceId],
    );
    const audit = await this.pool.query<{ actor_id: string; metadata: Record<string, unknown> }>(
      datasetId
        ? "SELECT a.actor_id, a.metadata FROM audit_logs a JOIN datasets ds ON ds.id = (a.metadata->>'datasetId') WHERE ds.workspace_id = $1 AND a.action = 'annotation_job.review_save' AND a.metadata->>'datasetId' = $2"
        : "SELECT a.actor_id, a.metadata FROM audit_logs a JOIN datasets ds ON ds.id = (a.metadata->>'datasetId') WHERE ds.workspace_id = $1 AND a.action = 'annotation_job.review_save'",
      datasetId ? [workspaceId, datasetId] : [workspaceId],
    );
    const scopedDocuments = documents.rows.map((row) => ({ ...row, annotations: Array.isArray(row.annotations) ? row.annotations as AnnotationRecord[] : [] })).filter((document) => actor.role !== 'annotator' || document.annotations.some((record) => record.createdBy === actor.id));
    const scopedJobs = jobs.rows.filter((job) => actor.role !== 'annotator' || job.assignee_id === actor.id);
    const reviewerChanges = audit.rows.filter((row) => actor.role !== 'reviewer' || row.actor_id === actor.id);
    const count = (key: 'added' | 'modified' | 'deleted') => reviewerChanges.reduce((total, row) => total + Number((row.metadata.counts as Record<string, unknown> | undefined)?.[key] ?? 0), 0);
    return {
      datasetId,
      annotatorCreatedObjects: scopedDocuments.reduce((total, document) => total + document.annotations.filter((record) => record.createdByRole === 'annotator' && (actor.role !== 'annotator' || record.createdBy === actor.id)).length, 0),
      finalEffectiveObjects: scopedDocuments.reduce((total, document) => total + document.annotations.length, 0),
      completedFrames: scopedDocuments.filter((document) => document.review_status === 'approved').length,
      completedJobs: scopedJobs.filter((job) => ['submitted', 'reviewing', 'approved'].includes(job.status)).length,
      reviewerAddedObjects: count('added'),
      reviewerModifiedObjects: count('modified'),
      reviewerDeletedObjects: count('deleted'),
      approvedJobs: scopedJobs.filter((job) => job.status === 'approved').length,
      rejectedJobs: scopedJobs.filter((job) => job.status === 'rework').length,
    };
  }
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
