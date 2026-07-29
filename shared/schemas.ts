import { z } from 'zod';
import { annotationReviewDecisions, annotationTypes, conversionFormats, dataFormats, trainingDataFormats, trainingTypes, userRoles } from './contracts';

export const loginSchema = z.object({
  username: z.string().trim().min(3).max(64),
  password: z.string().min(5).max(128),
});

export const userRoleSchema = z.enum(userRoles);

export const trainingDraftSchema = z.object({
  type: z.enum(trainingTypes),
  dataFormat: z.enum(dataFormats),
  name: z.string().trim().min(2).max(120),
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
}).superRefine((input, context) => {
  if (!(trainingDataFormats[input.type] as readonly string[]).includes(input.dataFormat)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['dataFormat'], message: '数据格式与训练任务不兼容' });
  }
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
  geometry: z.discriminatedUnion('type', [
    z.object({ type: z.literal(annotationTypes[0]), x: z.number().min(0).max(100), y: z.number().min(0).max(100), width: z.number().positive().max(100), height: z.number().positive().max(100) }),
    z.object({ type: z.literal(annotationTypes[1]), points: z.array(pointSchema).min(3).max(10000) }),
    z.object({ type: z.literal(annotationTypes[2]), x: z.number().min(0).max(100), y: z.number().min(0).max(100), index: z.number().int().positive() }),
    z.object({ type: z.literal(annotationTypes[3]), points: z.array(pointSchema).min(2).max(10000), strokeWidth: z.number().positive().max(20) }),
    z.object({ type: z.literal(annotationTypes[4]), cx: z.number().min(0).max(100), cy: z.number().min(0).max(100), rx: z.number().positive().max(100), ry: z.number().positive().max(100), rotation: z.number().min(-180).max(180) }),
    z.object({ type: z.literal(annotationTypes[5]), points: z.array(pointSchema.extend({ index: z.number().int().positive(), visibility: z.union([z.literal(0), z.literal(1), z.literal(2)]) })).min(1).max(1000), edges: z.array(z.tuple([z.number().int().positive(), z.number().int().positive()])).max(2000) }),
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

export const exportRequestSchema = z.object({
  format: z.enum(dataFormats),
  scope: z.enum(['all', 'train', 'validation', 'test']).default('all'),
  versionName: z.string().trim().min(1).max(120).default('export'),
  includeImages: z.boolean().default(true),
});

export const datasetCreateSchema = z.object({
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(1000).default(''),
  version: z.string().trim().min(1).max(40).default('v1'),
  classes: z.array(z.string().trim().min(1).max(80)).max(200).default([]),
});

export const datasetClassesSchema = z.object({
  classes: z.array(z.string().trim().min(1).max(80)).min(1).max(200),
});
