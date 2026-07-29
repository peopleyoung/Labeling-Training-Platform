import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AnnotationImageAttributes, AnnotationRecord } from '../shared/contracts';

export type StructuredTrainingTask = 'segmentation' | 'keypoint' | 'sdxl';

export interface StructuredTrainingImage {
  id: string;
  objectKey: string;
  filename: string;
  split: 'train' | 'validation' | 'test';
  annotations: AnnotationRecord[];
  caption?: string;
  imageAttributes?: AnnotationImageAttributes;
}

export interface StructuredTrainingDatasetInput {
  artifactRoot: string;
  outputDir: string;
  task: StructuredTrainingTask;
  dataFormat?: string;
  classes: string[];
  images: StructuredTrainingImage[];
}

function annotationsForTask(task: StructuredTrainingTask, annotations: AnnotationRecord[], classes: string[]) {
  if (task === 'sdxl') return annotations;
  if (task === 'segmentation') return annotations.filter((annotation) => annotation.geometry.type !== 'keypoint' && classes.includes(annotation.label));
  return annotations.filter((annotation) => annotation.geometry.type === 'keypoint' && annotation.geometry.index > 0);
}

export async function prepareStructuredTrainingDataset(input: StructuredTrainingDatasetInput) {
  const root = path.resolve(input.artifactRoot);
  const outputDir = path.resolve(input.outputDir);
  if (!outputDir.startsWith(`${root}${path.sep}`)) throw new Error('训练数据清单必须位于制品根目录内');
  const classes = [...new Set(input.classes.map((name) => name.trim()).filter(Boolean))];
  if (input.task !== 'sdxl' && !classes.length) throw new Error('训练数据集至少需要一个类别');

  const counts = { train: 0, validation: 0, test: 0 };
  let keypointCount = 0;
  const images = input.images.flatMap((image) => {
    const sourcePath = path.resolve(root, image.objectKey);
    if (!sourcePath.startsWith(`${root}${path.sep}`)) throw new Error(`数据集图片路径不合法：${image.filename}`);
    const annotations = annotationsForTask(input.task, Array.isArray(image.annotations) ? image.annotations : [], classes);
    const caption = image.caption?.trim();
    if (input.task === 'sdxl' && (!image.imageAttributes?.includeInSdxl || !caption)) return [];
    if (input.task !== 'sdxl' && !annotations.length) return [];
    for (const annotation of annotations) {
      if (annotation.geometry.type === 'keypoint') keypointCount = Math.max(keypointCount, annotation.geometry.index);
    }
    counts[image.split] += 1;
    return [{ id: image.id, path: sourcePath, filename: image.filename, split: image.split, annotations, prompt: caption, crop: image.imageAttributes?.crop, tags: image.imageAttributes?.tags ?? [] }];
  });

  if (!counts.train) throw new Error(input.task === 'sdxl' ? '训练分片没有已审核且包含主 Caption 的 SDXL 图片' : '训练分片没有包含当前任务可用的已标注图片');
  if (input.task === 'keypoint' && keypointCount < 1) throw new Error('关键点数据集没有有效的关键点编号');

  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  const manifestPath = path.join(outputDir, 'dataset.json');
  await writeFile(manifestPath, JSON.stringify({ version: 1, task: input.task, dataFormat: input.dataFormat, classes, keypointCount, counts, images }, null, 2), 'utf8');
  return { manifestPath, classes, keypointCount, counts, imageCount: images.length };
}
