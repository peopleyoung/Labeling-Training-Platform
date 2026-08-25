export const userRoles = ['admin', 'engineer', 'annotator'] as const;
export type UserRole = (typeof userRoles)[number];

export const trainingTypes = ['detection', 'segmentation', 'instance_segmentation', 'keypoint', 'sdxl'] as const;
export type TrainingType = (typeof trainingTypes)[number];

export const jobStatuses = ['queued', 'running', 'completed', 'failed', 'cancelled'] as const;
export type JobStatus = (typeof jobStatuses)[number];

export const conversionFormats = ['ONNX', 'TensorRT', 'TorchScript', 'OpenVINO'] as const;
export type ConversionFormat = (typeof conversionFormats)[number];

export const dataFormats = ['YOLO', 'COCO', 'VOC', 'COCO_SEGMENTATION', 'PNG_MASK', 'YOLO_SEG', 'COCO_KEYPOINTS', 'IMAGE_FOLDER'] as const;
export type DataFormat = (typeof dataFormats)[number];
export type TrainingDataFormat = DataFormat;

export const trainingDataFormats = {
  detection: ['YOLO', 'COCO', 'VOC'],
  segmentation: ['COCO_SEGMENTATION', 'PNG_MASK'],
  instance_segmentation: ['YOLO_SEG'],
  keypoint: ['COCO_KEYPOINTS'],
  sdxl: ['IMAGE_FOLDER'],
} as const satisfies Record<TrainingType, readonly TrainingDataFormat[]>;

export const architectureVariants = ['standard', 'rk_compatible'] as const;
export type ArchitectureVariant = (typeof architectureVariants)[number];

export const rkCompatibilityStatuses = ['not_reviewed', 'standard_only', 'rk_structure_ready', 'onnx_validated', 'device_validated'] as const;
export type RkCompatibilityStatus = (typeof rkCompatibilityStatuses)[number];

export const outputProtocols = ['segmentation_logits', 'yolo_detection', 'yolo_segmentation', 'yolo_pose', 'heatmap', 'sdxl_unet'] as const;
export type OutputProtocol = (typeof outputProtocols)[number];

export interface ModelVariantMetadata {
  architectureVariant: ArchitectureVariant;
  targetFamily?: 'rockchip_npu';
  rkCompatibilityStatus: RkCompatibilityStatus;
  outputProtocol: OutputProtocol;
  supportedOpset?: number;
}

export const annotationTypes = ['rectangle', 'polygon', 'keypoint', 'polyline', 'ellipse', 'skeleton'] as const;
export type AnnotationType = (typeof annotationTypes)[number];

export const annotationReviewStatuses = ['draft', 'submitted', 'approved', 'rejected'] as const;
export type AnnotationReviewStatus = (typeof annotationReviewStatuses)[number];

export const annotationReviewDecisions = ['approve', 'reject'] as const;
export type AnnotationReviewDecision = (typeof annotationReviewDecisions)[number];

export type DatasetType = '目标检测' | '语义分割' | '关键点';

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

export interface AuthUser {
  id: string;
  workspaceId: string;
  username: string;
  displayName: string;
  role: UserRole;
  mustChangePassword: boolean;
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
  name: string;
  description: string;
  version: string;
  legacyType?: DatasetType;
  /** @deprecated Legacy in-memory fixtures only. New API responses use legacyType. */
  type?: DatasetType;
  images: number;
  annotated: number;
  classes: string[];
  updatedAt: string;
  size: string;
  status: '标注中' | '可训练' | '待审核';
}

export interface DatasetImage {
  id: string;
  datasetId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
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
  | { type: 'keypoint'; x: number; y: number; index: number; visibility?: 0 | 1 | 2 }
  | { type: 'polyline'; points: AnnotationPoint[]; strokeWidth: number }
  | { type: 'ellipse'; cx: number; cy: number; rx: number; ry: number; rotation: number }
  | { type: 'skeleton'; points: AnnotationKeypoint[]; edges: Array<[number, number]> };

export interface AnnotationRecord {
  id: string;
  label: string;
  color: string;
  geometry: AnnotationGeometry;
  /** Optional instance grouping used by YOLO-Seg and multi-instance pose data. */
  instanceId?: string;
  locked?: boolean;
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
  architectureVariant?: ArchitectureVariant;
  weightSource: 'pretrained' | 'scratch';
  epochs: number;
  batchSize: number;
  learningRate: string;
  imageSize: number;
  gpu: string;
  mixedPrecision: boolean;
  earlyStopping: boolean;
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
  architectureVariant?: ArchitectureVariant;
  targetFamily?: 'rockchip_npu';
  rkCompatibilityStatus?: RkCompatibilityStatus;
  outputProtocol?: OutputProtocol;
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
