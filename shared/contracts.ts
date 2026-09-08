export const userRoles = ['admin', 'reviewer', 'annotator'] as const;
export type UserRole = (typeof userRoles)[number];

export const trainingTypes = ['detection', 'segmentation', 'keypoint', 'sdxl'] as const;
export type TrainingType = (typeof trainingTypes)[number];

export const jobStatuses = ['queued', 'running', 'completed', 'failed', 'cancelled'] as const;
export type JobStatus = (typeof jobStatuses)[number];

export const conversionFormats = ['ONNX', 'TensorRT', 'TorchScript', 'OpenVINO'] as const;
export type ConversionFormat = (typeof conversionFormats)[number];

export const dataFormats = ['YOLO', 'COCO', 'VOC', 'YOLO_SEGMENTATION', 'COCO_SEGMENTATION', 'PNG_MASK', 'YOLO_KEYPOINTS', 'COCO_KEYPOINTS', 'IMAGE_FOLDER', 'CVAT_JSON', 'CVAT_XML'] as const;
export type DataFormat = (typeof dataFormats)[number];
export type TrainingDataFormat = DataFormat;

export const trainingDataFormats = {
  detection: ['YOLO', 'COCO', 'VOC'],
  segmentation: ['YOLO_SEGMENTATION', 'COCO_SEGMENTATION', 'PNG_MASK'],
  keypoint: ['YOLO_KEYPOINTS', 'COCO_KEYPOINTS'],
  sdxl: ['IMAGE_FOLDER'],
} as const satisfies Record<TrainingType, readonly TrainingDataFormat[]>;

export const annotationTypes = ['rectangle', 'polygon', 'keypoint', 'polyline', 'ellipse', 'skeleton', 'cuboid'] as const;
export type AnnotationType = (typeof annotationTypes)[number];

export const annotationReviewStatuses = ['draft', 'submitted', 'approved', 'rejected'] as const;
export type AnnotationReviewStatus = (typeof annotationReviewStatuses)[number];

export const annotationReviewDecisions = ['approve', 'reject'] as const;
export type AnnotationReviewDecision = (typeof annotationReviewDecisions)[number];

export const annotationTaskStatuses = ['draft', 'processing', 'ready', 'annotating', 'reviewing', 'paused', 'completed', 'cancelled'] as const;
export type AnnotationTaskStatus = (typeof annotationTaskStatuses)[number];
export interface AnnotationTask {
  id: string;
  datasetId: string;
  name: string;
  status: AnnotationTaskStatus;
  createdAt: string;
}
export const sourceAssetTypes = ['image', 'archive', 'video'] as const;
export type SourceAssetType = (typeof sourceAssetTypes)[number];
export const uploadStatuses = ['created', 'uploading', 'uploaded', 'upload_failed', 'cancelled'] as const;
export type UploadStatus = (typeof uploadStatuses)[number];

export interface SourceAsset {
  id: string;
  datasetId: string;
  type: SourceAssetType;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256?: string;
  objectKey?: string;
  relativePath?: string;
  uploadStatus: UploadStatus;
  processingStatus: 'pending' | 'processing' | 'processed' | 'partial_failed' | 'failed';
  processingError?: string;
  createdAt: string;
}

export const processingRunStatuses = ['queued', 'running', 'completed', 'partial_failed', 'failed', 'cancelled'] as const;
export type ProcessingRunStatus = (typeof processingRunStatuses)[number];
export type FrameExtractionStrategy = 'fps' | 'interval_ms' | 'frame_step' | 'keyframe';
export interface DatasetProcessingConfig {
  segmentSize: number;
  extractionStrategy: FrameExtractionStrategy;
  frameStep: number;
  startFrame?: number;
  endFrame?: number;
  imageQuality: number;
  overlapSize: number;
  blockSize?: number;
  useZipBlocks: boolean;
  zOrder: boolean;
}
export interface ProcessingRun {
  id: string;
  datasetId: string;
  sourceAssetId?: string;
  status: ProcessingRunStatus;
  progress: number;
  extractionStrategy?: FrameExtractionStrategy;
  frameStep?: number;
  startFrame?: number;
  endFrame?: number;
  segmentSize?: number;
  imageQuality?: number;
  overlapSize?: number;
  blockSize?: number;
  useZipBlocks?: boolean;
  zOrder?: boolean;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AnnotationSegment {
  id: string;
  datasetId: string;
  annotationTaskId: string;
  sourceAssetId?: string;
  sequence: number;
  startItemId: string;
  endItemId: string;
  itemCount: number;
  createdAt: string;
}

export const annotationJobStatuses = ['available', 'claimed', 'in_progress', 'submitted', 'reviewing', 'approved', 'rework', 'cancelled'] as const;
export type AnnotationJobStatus = (typeof annotationJobStatuses)[number];
export interface AnnotationJob {
  id: string;
  datasetId: string;
  annotationTaskId: string;
  segmentId: string;
  sequence: number;
  status: AnnotationJobStatus;
  assigneeId?: string;
  claimedAt?: string;
  submittedAt?: string;
  reviewedAt?: string;
  reviewerId?: string;
  reviewComment?: string;
  createdAt: string;
}

export interface UploadSession {
  id: string;
  datasetId: string;
  assetId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  partSize: number;
  totalParts: number;
  completedParts: number[];
  status: UploadStatus;
  createdAt: string;
  expiresAt: string;
}

export interface ApiErrorBody {
  code: string;
  message: string;
  fields?: Record<string, string>;
  requestId: string;
}

export interface ApiErrorEnvelope {
  error: ApiErrorBody;
}

export interface RuntimeCapabilities {
  gpuEnabled: boolean;
  cpuTrainingEnabled: boolean;
  cpuOnnxEnabled: boolean;
  cpuConversionFormats: ConversionFormat[];
}

export interface SystemSettings {
  uploadMaxBytes: number;
  defaultImageSegmentSize: number;
  defaultVideoSegmentSize: number;
  autosaveIntervalSeconds: number;
  retentionDays: number;
  allowedVideoFormats: string[];
}

export interface AuthUser {
  id: string;
  workspaceId: string;
  username: string;
  displayName: string;
  role: UserRole;
  roles?: UserRole[];
  mustChangePassword: boolean;
  enabled?: boolean;
}

export const roleAliases: Record<UserRole, UserRole> = { admin: 'admin', reviewer: 'reviewer', annotator: 'annotator' };

export function effectiveUserRoles(user: Pick<AuthUser, 'role' | 'roles'>): UserRole[] {
  return [roleAliases[user.role]];
}

export interface WorkspaceActivity {
  id: string;
  action: string;
  entityType: string;
  entityId?: string;
  metadata: Record<string, unknown>;
  actor: Pick<AuthUser, 'id' | 'displayName'> | null;
  createdAt: string;
}

export interface LoginResponse {
  accessToken: string;
  user: AuthUser;
}

export interface Dataset {
  id: string;
  taskTypeId?: string;
  createdAt?: string;
  approvedAt?: string;
  name: string;
  description: string;
  version: string;
  images: number;
  annotated: number;
  classes: string[];
  labels?: DatasetLabel[];
  updatedAt: string;
  size: string;
  status: '标注中' | '可训练' | '待审核';
  annotatorIds?: string[];
  reviewerIds?: string[];
  processingConfig?: DatasetProcessingConfig;
}

export type DatasetLabelAttributeType = 'enum' | 'boolean' | 'integer' | 'text';
export interface DatasetLabelAttribute { name: string; type: DatasetLabelAttributeType; values?: string[]; required?: boolean; }
export interface DatasetLabel { name: string; color: string; attributes: DatasetLabelAttribute[]; }

export interface DatasetDeletionPreview {
  resourceId: string;
  counts: { assets: number; images: number; annotations: number; segments: number; jobs: number; exports: number; trainingJobs: number; models: number };
  releasedBytes: number;
}

export interface DatasetImage {
  id: string;
  datasetId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sourceAssetId?: string;
  sourceRelativePath?: string;
  sourceFrameNumber?: number;
  sourceTimestampMs?: number;
  extractionOrder?: number;
  thumbnailObjectKey?: string;
  processingRunId?: string;
  width?: number;
  height?: number;
  split: 'train' | 'validation' | 'test';
  createdAt: string;
}

export interface AnnotationPoint {
  x: number;
  y: number;
}

export interface AnnotationKeypoint extends AnnotationPoint {
  index: number;
  visibility: 0 | 1 | 2;
}

export type AnnotationGeometry =
  | { type: 'rectangle'; x: number; y: number; width: number; height: number }
  | { type: 'polygon'; points: AnnotationPoint[] }
  | { type: 'keypoint'; x: number; y: number; index: number }
  | { type: 'polyline'; points: AnnotationPoint[]; strokeWidth: number }
  | { type: 'ellipse'; cx: number; cy: number; rx: number; ry: number; rotation: number }
  | { type: 'skeleton'; points: AnnotationKeypoint[]; edges: Array<[number, number]> }
  | { type: 'cuboid'; points: AnnotationPoint[] };

export interface AnnotationRecord {
  id: string;
  label: string;
  color: string;
  geometry: AnnotationGeometry;
  locked?: boolean;
  occluded?: boolean;
  outside?: boolean;
  zOrder?: number;
  attributes?: Record<string, string | number | boolean>;
  trackId?: string;
  keyframe?: boolean;
  provenance?: 'manual' | 'interpolated' | 'copied';
  flagged?: boolean;
  createdBy?: string;
  createdByRole?: UserRole;
  createdAt?: string;
  updatedBy?: string;
  updatedByRole?: UserRole;
  updatedAt?: string;
}

export type AnnotationAuditChangeType = 'created' | 'updated' | 'deleted';

export interface AnnotationAuditChange {
  objectId: string;
  changeType: AnnotationAuditChangeType;
  changedFields: string[];
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
}

export interface AnnotationAuditCounts {
  added: number;
  modified: number;
  deleted: number;
}

export interface AnnotationStatistics {
  datasetId?: string;
  annotatorCreatedObjects: number;
  finalEffectiveObjects: number;
  completedFrames: number;
  completedJobs: number;
  reviewerAddedObjects: number;
  reviewerModifiedObjects: number;
  reviewerDeletedObjects: number;
  approvedJobs: number;
  rejectedJobs: number;
}

export interface AnnotatorPerformance {
  annotatorId: string;
  annotatorName: string;
  enabled: boolean;
  validAnnotationCount: number;
  approvedJobs: number;
  rejectedJobs: number;
  reviewedJobs: number;
  rejectionRate: number;
}

export interface AnnotatorPerformanceFilter {
  startDate?: string;
  endDate?: string;
}

export interface ImageCaption {
  id: string;
  text: string;
  language: 'en' | 'zh';
  primary: boolean;
  source: 'human' | 'ai';
}

export interface AnnotationImageAttributes {
  includeInSdxl: boolean;
  tags: string[];
  crop?: { x: number; y: number; width: number; height: number };
}

export interface AnnotationDocument {
  datasetId: string;
  imageId: string;
  revision: number;
  annotations: AnnotationRecord[];
  captions: ImageCaption[];
  imageAttributes: AnnotationImageAttributes;
  updatedAt: string;
  updatedBy: string;
  reviewStatus: AnnotationReviewStatus;
  submittedAt?: string;
  submittedBy?: string;
  reviewedAt?: string;
  reviewedBy?: string;
  reviewComment?: string;
}

export interface AnnotationReviewItem {
  imageId: string;
  filename: string;
  revision: number;
  annotationCount: number;
  reviewStatus: AnnotationReviewStatus;
  submittedAt?: string;
  submittedBy?: string;
  reviewedAt?: string;
  reviewedBy?: string;
  reviewComment?: string;
}

export interface AnnotationReviewSummary {
  datasetId: string;
  datasetStatus: Dataset['status'];
  total: number;
  draft: number;
  submitted: number;
  approved: number;
  rejected: number;
  items: AnnotationReviewItem[];
}

export interface AnnotationReviewDecisionInput {
  imageIds: string[];
  decision: AnnotationReviewDecision;
  comment?: string;
}

export interface TrainingDraft {
  type: TrainingType;
  dataFormat: TrainingDataFormat;
  name: string;
  version: string;
  datasetId: string;
  model: string;
  weightSource: 'pretrained' | 'scratch';
  epochs: number;
  batchSize: number;
  learningRate: string;
  imageSize: number;
  gpu: string;
  mixedPrecision: boolean;
  earlyStopping: boolean;
  jobIds?: string[];
}

export interface TrainingSnapshot {
  id: string;
  datasetId: string;
  jobIds: string[];
  createdAt: string;
  classes: string[];
  processingRunIds: string[];
  processingConfig: Record<string, unknown>;
  images: Array<DatasetImage & { objectKey: string }>;
  documents: AnnotationDocument[];
}

export interface TrainingJob {
  id: string;
  name: string;
  type: TrainingType;
  model: string;
  dataset: string;
  status: JobStatus;
  progress: number;
  epoch: string;
  metricName: string;
  metricValue: string;
  gpu: string;
  createdAt: string;
  eta: string;
  createdBy?: string;
  errorMessage?: string;
  config?: TrainingDraft;
  artifactId?: string;
  snapshotId?: string;
}

export interface TrainingEvent {
  id: string;
  jobId: string;
  level: 'info' | 'warning' | 'error';
  message: string;
  createdAt: string;
}

export interface TrainingMetricPoint {
  id: string;
  jobId: string;
  epoch: number;
  progress: number;
  metrics: Record<string, number>;
  createdAt: string;
}

export interface TrainingResourceSample {
  id: string;
  jobId: string;
  device: 'cpu' | 'gpu';
  cpuPercent: number;
  memoryUsedMb: number;
  memoryTotalMb?: number;
  gpuPercent?: number;
  gpuMemoryUsedMb?: number;
  gpuMemoryTotalMb?: number;
  gpuPowerWatts?: number;
  createdAt: string;
}

export interface TrainingObservability {
  metrics: TrainingMetricPoint[];
  resources: TrainingResourceSample[];
}

export interface ModelVersion {
  id: string;
  name: string;
  version: string;
  task: TrainingType;
  sourceJob: string;
  metricName: string;
  metricValue: string;
  framework: string;
  size: string;
  createdAt: string;
  formats: ConversionFormat[];
  stage: '生产候选' | '评估中' | '已归档';
  artifactId?: string;
  snapshotId?: string;
}

export interface ConversionTask {
  id: string;
  modelName: string;
  modelVersion: string;
  format: ConversionFormat;
  precision: string;
  target: string;
  status: JobStatus;
  progress: number;
  size: string;
  createdAt: string;
  createdBy?: string;
  errorMessage?: string;
  artifactId?: string;
  options?: Record<string, string | boolean>;
}

export interface ExportTask {
  id: string;
  datasetId: string;
  format: DataFormat;
  status: JobStatus;
  progress: number;
  artifactId?: string;
  createdAt: string;
  errorMessage?: string;
  scope?: 'all' | 'train' | 'validation' | 'test';
  versionName?: string;
  includeImages?: boolean;
  jobIds?: string[];
}

export interface Artifact {
  id: string;
  objectKey: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  sourceType: string;
  sourceId: string;
  createdAt: string;
}

export interface ResourceDeletionResult {
  releasedBytes: number;
  removedFiles: number;
  removedDirectories: number;
  removedModels: number;
  removedConversions: number;
  removedExports: number;
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
}
