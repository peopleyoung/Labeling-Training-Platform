import { z } from 'zod';
import { annotationReviewDecisions, annotationTypes, conversionFormats, dataFormats, sourceAssetTypes, trainingDataFormats, trainingTypes, userRoles } from './contracts';

export const loginSchema = z.object({
  username: z.string().trim().min(3).max(64),
  password: z.string().min(5).max(128),
});

export const userRoleSchema = z.enum(userRoles);
export const userRolesSchema = z.array(userRoleSchema).length(1, '一个用户只能绑定一个角色');
export const userCreateSchema = z.object({
  username: z.string().trim().min(3).max(64),
  displayName: z.string().trim().min(1).max(120),
  password: z.string().min(5).max(128),
  roles: userRolesSchema,
});
export const userUpdateSchema = z.object({
  displayName: z.string().trim().min(1).max(120).optional(),
  roles: userRolesSchema.optional(),
  enabled: z.boolean().optional(),
  password: z.string().min(5).max(128).optional(),
}).refine((input) => input.displayName !== undefined || input.roles !== undefined || input.enabled !== undefined || input.password !== undefined, '至少提供一项修改内容');

export const systemSettingsSchema = z.object({
  uploadMaxBytes: z.number().int().positive().max(10 * 1024 * 1024 * 1024).optional(),
  defaultImageSegmentSize: z.number().int().positive().max(100000).optional(),
  defaultVideoSegmentSize: z.number().int().positive().max(100000).optional(),
  autosaveIntervalSeconds: z.number().int().min(1).max(300).optional(),
  retentionDays: z.number().int().min(1).max(3650).optional(),
  allowedVideoFormats: z.array(z.string().regex(/^[a-z0-9]+$/)).min(1).max(30).optional(),
}).refine((input) => Object.keys(input).length > 0, '至少提供一项设置');

export const trainingDraftSchema = z.object({
  type: z.enum(trainingTypes),
  dataFormat: z.enum(dataFormats),
  name: z.string().trim().min(2).max(120),
  version: z.string().trim().min(1).max(40).default('v1'),
  datasetId: z.string().trim().min(1).max(80),
  model: z.string().trim().min(2).max(80),
  weightSource: z.enum(['pretrained', 'scratch']).default('pretrained'),
  epochs: z.number().int().min(1).max(5000),
  batchSize: z.number().int().min(1).max(512),
  learningRate: z.union([z.string(), z.number()]).transform(String).refine((value) => Number(value) > 0 && Number(value) <= 1, '学习率必须在 0 到 1 之间'),
  imageSize: z.number().int().min(128).max(2048),
  gpu: z.string().trim().min(1).max(80),
  mixedPrecision: z.boolean(),
  earlyStopping: z.boolean(),
  jobIds: z.array(z.string().trim().min(1)).max(10000).optional(),
}).superRefine((input, context) => {
  if (!(trainingDataFormats[input.type] as readonly string[]).includes(input.dataFormat)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['dataFormat'], message: '数据格式与训练任务不兼容' });
  }
});

export const uploadSessionCreateSchema = z.object({
  filename: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().min(1).max(120),
  sizeBytes: z.number().int().positive().max(10 * 1024 * 1024 * 1024),
  type: z.enum(sourceAssetTypes),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});

export const processingStartSchema = z.object({
  extractionStrategy: z.literal('frame_step').default('frame_step'),
  frameStep: z.number().int().min(1).max(100_000).default(1),
  startFrame: z.number().int().min(0).optional(),
  endFrame: z.number().int().min(0).optional(),
  segmentSize: z.number().int().min(1).max(10_000).default(100),
  imageQuality: z.number().int().min(1).max(100).default(95),
  overlapSize: z.number().int().min(0).max(10_000).default(0),
  blockSize: z.number().int().min(1).max(10_000).optional(),
  useZipBlocks: z.boolean().default(false),
  zOrder: z.boolean().default(false),
}).superRefine((input, context) => {
  if (input.overlapSize >= input.segmentSize) context.addIssue({ code: z.ZodIssueCode.custom, path: ['overlapSize'], message: '重叠大小必须小于段大小' });
  if (input.endFrame !== undefined && input.startFrame !== undefined && input.endFrame < input.startFrame) context.addIssue({ code: z.ZodIssueCode.custom, path: ['endFrame'], message: '结束帧不能小于开始帧' });
});

export const annotationJobUpdateSchema = z.object({
  status: z.enum(['available', 'claimed', 'in_progress', 'submitted', 'reviewing', 'approved', 'rework', 'cancelled']).optional(),
  assigneeId: z.string().trim().min(1).max(80).nullable().optional(),
  reviewComment: z.string().trim().max(1000).optional(),
}).refine((input) => input.status !== undefined || input.assigneeId !== undefined || input.reviewComment !== undefined, '至少提供一项修改内容');

export const annotationTaskPauseSchema = z.object({
  reason: z.string().trim().min(1).max(1000),
});

export const annotationJobReleaseSchema = z.object({
  reason: z.string().trim().min(1).max(1000),
});

export const annotationJobReassignSchema = z.object({
  assigneeId: z.string().trim().min(1).max(80),
  reason: z.string().trim().min(1).max(1000),
});

export const conversionRequestSchema = z.object({
  modelName: z.string().trim().min(1).max(120),
  modelVersion: z.string().trim().min(1).max(80),
  format: z.enum(conversionFormats),
  precision: z.string().trim().min(2).max(16),
  target: z.string().trim().min(2).max(80),
  options: z.record(z.string(), z.union([z.string().max(120), z.boolean()])).default({}),
});

export const modelUploadMetadataSchema = z.object({
  name: z.string().trim().min(2).max(120),
  version: z.string().trim().min(1).max(40),
  task: z.enum(trainingTypes),
  framework: z.string().trim().min(2).max(80),
  stage: z.enum(['生产候选', '评估中', '已归档']).default('评估中'),
  filename: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().min(1).max(120).default('application/octet-stream'),
});

export const modelStageSchema = z.object({
  stage: z.enum(['生产候选', '评估中', '已归档']),
});

const pointSchema = z.object({ x: z.number().min(0).max(100), y: z.number().min(0).max(100) });
const cropSchema = z.object({ x: z.number().min(0).max(100), y: z.number().min(0).max(100), width: z.number().positive().max(100), height: z.number().positive().max(100) }).superRefine((crop, context) => {
  if (crop.x + crop.width > 100 || crop.y + crop.height > 100) context.addIssue({ code: z.ZodIssueCode.custom, message: '裁剪区域必须位于图像范围内' });
});

export const annotationRecordSchema = z.object({
  id: z.string().trim().min(1).max(80),
  label: z.string().trim().min(1).max(80),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  locked: z.boolean().optional(),
  occluded: z.boolean().optional(),
  outside: z.boolean().optional(),
  zOrder: z.number().int().optional(),
  attributes: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  trackId: z.string().trim().min(1).max(120).optional(),
  keyframe: z.boolean().optional(),
  provenance: z.enum(['manual', 'interpolated', 'copied']).optional(),
  flagged: z.boolean().optional(),
  geometry: z.discriminatedUnion('type', [
    z.object({ type: z.literal(annotationTypes[0]), x: z.number().min(0).max(100), y: z.number().min(0).max(100), width: z.number().positive().max(100), height: z.number().positive().max(100) }),
    z.object({ type: z.literal(annotationTypes[1]), points: z.array(pointSchema).min(3).max(10000) }),
    z.object({ type: z.literal(annotationTypes[2]), x: z.number().min(0).max(100), y: z.number().min(0).max(100), index: z.number().int().positive() }),
    z.object({ type: z.literal(annotationTypes[3]), points: z.array(pointSchema).min(2).max(10000), strokeWidth: z.number().positive().max(20) }),
    z.object({ type: z.literal(annotationTypes[4]), cx: z.number().min(0).max(100), cy: z.number().min(0).max(100), rx: z.number().positive().max(100), ry: z.number().positive().max(100), rotation: z.number().min(-180).max(180) }),
    z.object({ type: z.literal(annotationTypes[5]), points: z.array(pointSchema.extend({ index: z.number().int().positive(), visibility: z.union([z.literal(0), z.literal(1), z.literal(2)]) })).min(1).max(1000), edges: z.array(z.tuple([z.number().int().positive(), z.number().int().positive()])).max(2000) }),
    z.object({ type: z.literal(annotationTypes[6]), points: z.array(pointSchema).length(8) }),
  ]),
});

export const imageCaptionSchema = z.object({
  id: z.string().trim().min(1).max(80),
  text: z.string().trim().min(1).max(2000),
  language: z.enum(['en', 'zh']).default('en'),
  primary: z.boolean().default(false),
  source: z.enum(['human', 'ai']).default('human'),
});

export const annotationImageAttributesSchema = z.object({
  includeInSdxl: z.boolean().default(false),
  tags: z.array(z.string().trim().min(1).max(80)).max(100).default([]),
  crop: cropSchema.optional(),
});

export const annotationSaveSchema = z.object({
  revision: z.number().int().min(0),
  annotations: z.array(annotationRecordSchema).max(100000),
  captions: z.array(imageCaptionSchema).max(20).optional(),
  imageAttributes: annotationImageAttributesSchema.optional(),
}).superRefine((input, context) => {
  if (input.captions && input.captions.filter((caption) => caption.primary).length > 1) context.addIssue({ code: z.ZodIssueCode.custom, path: ['captions'], message: '每张图片只能有一个主 Caption' });
});

export const annotationReviewDecisionSchema = z.object({
  imageIds: z.array(z.string().trim().min(1).max(80)).min(1).max(10000),
  decision: z.enum(annotationReviewDecisions),
  comment: z.string().trim().max(1000).optional(),
}).superRefine((input, context) => {
  if (input.decision === 'reject' && !input.comment) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['comment'], message: '驳回时必须填写原因' });
  }
});

export const annotationJobBatchReviewSchema = z.object({
  jobIds: z.array(z.string().trim().min(1).max(80)).min(1).max(10000),
  decision: z.enum(annotationReviewDecisions),
  comment: z.string().trim().max(1000).optional(),
}).superRefine((input, context) => {
  if (input.decision === 'reject' && !input.comment) context.addIssue({ code: z.ZodIssueCode.custom, path: ['comment'], message: '批量驳回时必须填写原因' });
});

export const annotationJobReviewSchema = z.object({
  decision: z.enum(annotationReviewDecisions),
  comment: z.string().trim().max(1000).optional(),
}).superRefine((input, context) => {
  if (input.decision === 'reject' && !input.comment) context.addIssue({ code: z.ZodIssueCode.custom, path: ['comment'], message: '驳回时必须填写原因' });
});

export const annotationJobReopenSchema = z.object({ reason: z.string().trim().min(1).max(1000) });

export const exportRequestSchema = z.object({
  format: z.enum(dataFormats),
  versionName: z.string().trim().min(1).max(120).default('export'),
  includeImages: z.boolean().default(true),
});

export const datasetCreateSchema = z.object({
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(1000).default(''),
  version: z.string().trim().min(1).max(40).default('v1'),
  classes: z.array(z.string().trim().min(1).max(80)).max(200).default([]),
  labels: z.array(z.object({ name: z.string().trim().min(1).max(80), color: z.string().regex(/^#[0-9a-fA-F]{6}$/), attributes: z.array(z.object({ name: z.string().trim().min(1).max(80), type: z.enum(['enum', 'boolean', 'integer', 'text']), values: z.array(z.string().trim().min(1).max(120)).max(100).optional(), required: z.boolean().optional() })).max(50) })).max(200).default([]),
  annotatorIds: z.array(z.string().trim().min(1).max(80)).max(500).default([]),
  reviewerIds: z.array(z.string().trim().min(1).max(80)).max(500).default([]),
  processingConfig: processingStartSchema.default({ extractionStrategy: 'frame_step', frameStep: 1, segmentSize: 100, imageQuality: 95, overlapSize: 0, useZipBlocks: false, zOrder: false }),
});

export const datasetClassesSchema = z.object({
  classes: z.array(z.string().trim().min(1).max(80)).min(1).max(200),
});
const datasetLabelAttributeSchema = z.object({ name: z.string().trim().min(1).max(80), type: z.enum(['enum', 'boolean', 'integer', 'text']), values: z.array(z.string().trim().min(1).max(120)).max(100).optional(), required: z.boolean().optional() });
export const datasetLabelsSchema = z.object({ labels: z.array(z.object({ name: z.string().trim().min(1).max(80), color: z.string().regex(/^#[0-9a-fA-F]{6}$/), attributes: z.array(datasetLabelAttributeSchema).max(50) })).max(200) });
