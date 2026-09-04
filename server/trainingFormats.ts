import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import type { AnnotationRecord, DataFormat, TrainingDataFormat, TrainingType } from '../shared/contracts';
import { materializeDatasetFormat, type DatasetExportInput, type ExportAnnotationDocument, type ExportImage } from './datasetExport';
import { prepareStructuredTrainingDataset } from './trainingDataset';
import { prepareYoloDataset } from './yoloDataset';

interface FormatManifestImage {
  id: string;
  file: string;
  split: ExportImage['split'];
  width: number;
  height: number;
}

interface FormatManifest {
  version: number;
  format: DataFormat;
  images: FormatManifestImage[];
}

interface CocoImage { id: number; file_name: string; width: number; height: number }
interface CocoCategory { id: number; name: string; keypoints?: string[] }
interface CocoAnnotation {
  id: number;
  image_id: number;
  category_id: number;
  bbox?: number[];
  segmentation?: number[][];
  keypoints?: number[];
}
interface CocoDocument { images: CocoImage[]; categories: CocoCategory[]; annotations: CocoAnnotation[] }
interface ImageFolderRow { file_name: string; text: string; split?: ExportImage['split']; tags?: string[]; crop?: { x: number; y: number; width: number; height: number } }

export interface TrainingFormatInput {
  artifactRoot: string;
  outputDir: string;
  task: TrainingType;
  format: TrainingDataFormat;
  dataset: DatasetExportInput['dataset'];
  images: ExportImage[];
  documents: ExportAnnotationDocument[];
}

export interface PreparedTrainingFormat {
  configPath: string;
  imageCount: number;
  classes: string[];
  format: TrainingDataFormat;
}

function packageImagePath(packageDir: string, format: DataFormat, image: FormatManifestImage) {
  return ['YOLO', 'YOLO_SEGMENTATION', 'YOLO_KEYPOINTS'].includes(format)
    ? path.join(packageDir, 'images', image.split === 'validation' ? 'val' : image.split, image.file)
    : path.join(packageDir, 'images', image.file);
}

function objectKey(artifactRoot: string, filePath: string) {
  const relative = path.relative(path.resolve(artifactRoot), path.resolve(filePath));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('训练格式文件不在制品根目录内');
  return relative;
}

async function readFormatManifest(manifestPath: string, expectedFormat: DataFormat) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as FormatManifest;
  if (manifest.version !== 2 || manifest.format !== expectedFormat || !Array.isArray(manifest.images) || !manifest.images.length) throw new Error(`${expectedFormat} 数据清单无效`);
  return manifest;
}

async function findJson(directory: string) {
  const { readdir } = await import('node:fs/promises');
  const filename = (await readdir(directory)).find((item) => item.endsWith('.json'));
  if (!filename) throw new Error(`目录缺少 JSON 标注：${directory}`);
  return path.join(directory, filename);
}

async function readCoco(packageDir: string) {
  const file = await findJson(path.join(packageDir, 'annotations'));
  const document = JSON.parse(await readFile(file, 'utf8')) as CocoDocument;
  if (!Array.isArray(document.images) || !Array.isArray(document.categories) || !Array.isArray(document.annotations)) throw new Error('COCO 标注结构无效');
  return document;
}

function rectangle(label: string, bbox: number[], width: number, height: number, id: string): AnnotationRecord | null {
  if (bbox.length < 4 || width <= 0 || height <= 0) return null;
  return { id, label, color: '#2383f2', geometry: { type: 'rectangle', x: bbox[0] * 100 / width, y: bbox[1] * 100 / height, width: bbox[2] * 100 / width, height: bbox[3] * 100 / height } };
}

function cocoDetectionImages(coco: CocoDocument, manifest: FormatManifest, classes: string[]) {
  const categories = new Map(coco.categories.map((category) => [category.id, category.name]));
  const manifestByFile = new Map(manifest.images.map((image) => [image.file, image]));
  return coco.images.flatMap((image) => {
    const source = manifestByFile.get(image.file_name);
    if (!source) return [];
    const annotations = coco.annotations.filter((annotation) => annotation.image_id === image.id).flatMap((annotation) => {
      const label = categories.get(annotation.category_id) ?? classes[0];
      const record = rectangle(label, annotation.bbox ?? [], image.width, image.height, `coco-${annotation.id}`);
      return record ? [record] : [];
    });
    return annotations.length ? [{ source, annotations }] : [];
  });
}

async function prepareCocoDetection(input: TrainingFormatInput, packageDir: string, manifest: FormatManifest) {
  const coco = await readCoco(packageDir);
  const records = cocoDetectionImages(coco, manifest, input.dataset.classes);
  return prepareYoloDataset({
    artifactRoot: input.artifactRoot,
    outputDir: path.join(input.outputDir, 'native'),
    classes: input.dataset.classes,
    images: records.map(({ source, annotations }) => ({ id: source.id, objectKey: objectKey(input.artifactRoot, packageImagePath(packageDir, 'COCO', source)), filename: source.file, split: source.split, annotations })),
  });
}

function asArray<T>(value: T | T[] | undefined): T[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

async function prepareVocDetection(input: TrainingFormatInput, packageDir: string, manifest: FormatManifest) {
  const parser = new XMLParser();
  const images = [] as Array<{ id: string; objectKey: string; filename: string; split: ExportImage['split']; annotations: AnnotationRecord[] }>;
  for (const source of manifest.images) {
    const xmlPath = path.join(packageDir, 'Annotations', `${path.parse(source.file).name}.xml`);
    const parsed = parser.parse(await readFile(xmlPath, 'utf8')) as {
      annotation?: { object?: { name?: string; bndbox?: { xmin?: number; ymin?: number; xmax?: number; ymax?: number } } | Array<{ name?: string; bndbox?: { xmin?: number; ymin?: number; xmax?: number; ymax?: number } }> };
    };
    const annotations = asArray(parsed.annotation?.object).flatMap((item, index) => {
      const box = item.bndbox;
      if (!box) return [];
      const record = rectangle(String(item.name ?? input.dataset.classes[0]), [Number(box.xmin), Number(box.ymin), Number(box.xmax) - Number(box.xmin), Number(box.ymax) - Number(box.ymin)], source.width, source.height, `voc-${source.id}-${index}`);
      return record ? [record] : [];
    });
    if (annotations.length) images.push({ id: source.id, objectKey: objectKey(input.artifactRoot, packageImagePath(packageDir, 'VOC', source)), filename: source.file, split: source.split, annotations });
  }
  return prepareYoloDataset({ artifactRoot: input.artifactRoot, outputDir: path.join(input.outputDir, 'native'), classes: input.dataset.classes, images });
}

async function prepareCocoSegmentation(input: TrainingFormatInput, packageDir: string, manifest: FormatManifest) {
  const coco = await readCoco(packageDir);
  const categories = new Map(coco.categories.map((category) => [category.id, category.name]));
  const cocoByFile = new Map(coco.images.map((image) => [image.file_name, image]));
  const images = manifest.images.flatMap((source) => {
    const image = cocoByFile.get(source.file);
    if (!image) return [];
    const annotations = coco.annotations.filter((annotation) => annotation.image_id === image.id).flatMap((annotation) => {
      const label = categories.get(annotation.category_id) ?? input.dataset.classes[0];
      const points = annotation.segmentation?.[0];
      if (points && points.length >= 6) return [{ id: `coco-seg-${annotation.id}`, label, color: '#2383f2', geometry: { type: 'polygon' as const, points: Array.from({ length: Math.floor(points.length / 2) }, (_, index) => ({ x: points[index * 2] * 100 / image.width, y: points[index * 2 + 1] * 100 / image.height })) } }];
      const record = rectangle(label, annotation.bbox ?? [], image.width, image.height, `coco-seg-${annotation.id}`);
      return record ? [record] : [];
    });
    return annotations.length ? [{ id: source.id, objectKey: objectKey(input.artifactRoot, packageImagePath(packageDir, 'COCO_SEGMENTATION', source)), filename: source.file, split: source.split, annotations }] : [];
  });
  return prepareStructuredTrainingDataset({ artifactRoot: input.artifactRoot, outputDir: path.join(input.outputDir, 'native'), task: 'segmentation', dataFormat: 'COCO_SEGMENTATION', classes: input.dataset.classes, images });
}

async function preparePngMasks(input: TrainingFormatInput, packageDir: string, manifest: FormatManifest) {
  const classes = input.dataset.classes;
  const images = await Promise.all(manifest.images.map(async (source) => {
    const imagePath = packageImagePath(packageDir, 'PNG_MASK', source);
    const maskPath = path.join(packageDir, 'masks', `${path.parse(source.file).name}.png`);
    await Promise.all([stat(imagePath), stat(maskPath)]);
    return { id: source.id, path: imagePath, maskPath, filename: source.file, split: source.split, annotations: [] };
  }));
  const counts = { train: images.filter((image) => image.split === 'train').length, validation: images.filter((image) => image.split === 'validation').length, test: images.filter((image) => image.split === 'test').length };
  if (!counts.train) throw new Error('PNG Mask 训练数据没有 train 分片');
  const manifestPath = path.join(input.outputDir, 'native', 'dataset.json');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, JSON.stringify({ version: 1, task: 'segmentation', dataFormat: 'PNG_MASK', classes, counts, images }, null, 2));
  return { manifestPath, imageCount: images.length, classes };
}

async function prepareCocoKeypoints(input: TrainingFormatInput, packageDir: string, manifest: FormatManifest) {
  const coco = await readCoco(packageDir);
  const keypointCount = coco.categories[0]?.keypoints?.length ?? 0;
  if (!keypointCount) throw new Error('COCO Keypoints 缺少关键点定义');
  const cocoByFile = new Map(coco.images.map((image) => [image.file_name, image]));
  const images = manifest.images.flatMap((source) => {
    const image = cocoByFile.get(source.file);
    if (!image) return [];
    const annotation = coco.annotations.find((item) => item.image_id === image.id);
    if (!annotation?.keypoints) return [];
    const annotations = Array.from({ length: keypointCount }, (_, index) => {
      const x = annotation.keypoints?.[index * 3] ?? 0;
      const y = annotation.keypoints?.[index * 3 + 1] ?? 0;
      const visible = annotation.keypoints?.[index * 3 + 2] ?? 0;
      return visible > 0 ? { id: `coco-kpt-${annotation.id}-${index + 1}`, label: coco.categories[0]?.keypoints?.[index] ?? `point_${index + 1}`, color: '#7357c6', geometry: { type: 'keypoint' as const, x: x * 100 / image.width, y: y * 100 / image.height, index: index + 1 } } : null;
    }).filter((item): item is NonNullable<typeof item> => item !== null);
    return annotations.length ? [{ id: source.id, objectKey: objectKey(input.artifactRoot, packageImagePath(packageDir, 'COCO_KEYPOINTS', source)), filename: source.file, split: source.split, annotations }] : [];
  });
  return prepareStructuredTrainingDataset({ artifactRoot: input.artifactRoot, outputDir: path.join(input.outputDir, 'native'), task: 'keypoint', dataFormat: 'COCO_KEYPOINTS', classes: input.dataset.classes, images });
}

export async function prepareTrainingFormat(input: TrainingFormatInput): Promise<PreparedTrainingFormat> {
  if (input.format === 'IMAGE_FOLDER') {
    const packageDir = path.join(input.outputDir, 'selected');
    const materialized = await materializeDatasetFormat({ ...input, format: input.format, scope: 'all', versionName: 'training', includeImages: true }, packageDir);
    const manifest = await readFormatManifest(materialized.manifestPath, input.format);
    const rows = (await readFile(path.join(packageDir, 'metadata.jsonl'), 'utf8')).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as ImageFolderRow);
    const metadata = new Map(rows.map((row) => [row.file_name, row]));
    const prepared = await prepareStructuredTrainingDataset({
      artifactRoot: input.artifactRoot,
      outputDir: path.join(input.outputDir, 'native'),
      task: 'sdxl',
      dataFormat: 'IMAGE_FOLDER',
      classes: input.dataset.classes,
      images: manifest.images.map((image) => {
        const fileName = `images/${image.file}`;
        const row = metadata.get(fileName);
        if (!row?.text?.trim()) throw new Error(`Image Folder Caption 缺失：${image.file}`);
        return { id: image.id, objectKey: objectKey(input.artifactRoot, path.join(packageDir, fileName)), filename: image.file, split: image.split, annotations: [], caption: row.text, imageAttributes: { includeInSdxl: true, tags: row.tags ?? [], crop: row.crop } };
      }),
    });
    return { configPath: prepared.manifestPath, imageCount: prepared.imageCount, classes: prepared.classes, format: input.format };
  }
  const packageDir = path.join(input.outputDir, 'selected');
  const materialized = await materializeDatasetFormat({ ...input, format: input.format, scope: 'all', versionName: 'training', includeImages: true }, packageDir);
  const manifest = await readFormatManifest(materialized.manifestPath, input.format);
  if (['YOLO', 'YOLO_SEGMENTATION', 'YOLO_KEYPOINTS'].includes(input.format)) return { configPath: path.join(packageDir, 'dataset.yaml'), imageCount: manifest.images.length, classes: materialized.classes, format: input.format };
  if (input.format === 'COCO') {
    const prepared = await prepareCocoDetection(input, packageDir, manifest);
    return { configPath: prepared.yamlPath, imageCount: prepared.imageCount, classes: prepared.classes, format: input.format };
  }
  if (input.format === 'VOC') {
    const prepared = await prepareVocDetection(input, packageDir, manifest);
    return { configPath: prepared.yamlPath, imageCount: prepared.imageCount, classes: prepared.classes, format: input.format };
  }
  if (input.format === 'COCO_SEGMENTATION') {
    const prepared = await prepareCocoSegmentation(input, packageDir, manifest);
    return { configPath: prepared.manifestPath, imageCount: prepared.imageCount, classes: prepared.classes, format: input.format };
  }
  if (input.format === 'PNG_MASK') {
    const prepared = await preparePngMasks(input, packageDir, manifest);
    return { configPath: prepared.manifestPath, imageCount: prepared.imageCount, classes: prepared.classes, format: input.format };
  }
  const prepared = await prepareCocoKeypoints(input, packageDir, manifest);
  return { configPath: prepared.manifestPath, imageCount: prepared.imageCount, classes: prepared.classes, format: input.format };
}
