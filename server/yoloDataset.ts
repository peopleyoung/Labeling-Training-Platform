import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AnnotationRecord } from '../shared/contracts';

export interface YoloDatasetImage {
  id: string;
  objectKey: string;
  filename: string;
  split: 'train' | 'validation' | 'test';
  annotations: AnnotationRecord[];
}

export interface YoloDatasetInput {
  artifactRoot: string;
  outputDir: string;
  classes: string[];
  images: YoloDatasetImage[];
}

function safeStem(value: string) {
  return value.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '_') || 'image';
}

function splitName(split: YoloDatasetImage['split']) {
  return split === 'validation' ? 'val' : split;
}

function yoloBox(annotation: AnnotationRecord) {
  const geometry = annotation.geometry;
  if (geometry.type === 'keypoint' || geometry.type === 'skeleton' || geometry.type === 'polyline') return null;
  if (geometry.type === 'rectangle') {
    return [geometry.x + geometry.width / 2, geometry.y + geometry.height / 2, geometry.width, geometry.height].map((value) => value / 100);
  }
  const points = geometry.type === 'polygon' ? geometry.points : Array.from({ length: 32 }, (_, index) => {
    const angle = index * Math.PI * 2 / 32;
    const rotation = geometry.rotation * Math.PI / 180;
    const localX = geometry.rx * Math.cos(angle);
    const localY = geometry.ry * Math.sin(angle);
    return { x: geometry.cx + localX * Math.cos(rotation) - localY * Math.sin(rotation), y: geometry.cy + localX * Math.sin(rotation) + localY * Math.cos(rotation) };
  });
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const left = Math.min(...xs);
  const right = Math.max(...xs);
  const top = Math.min(...ys);
  const bottom = Math.max(...ys);
  return [(left + right) / 200, (top + bottom) / 200, (right - left) / 100, (bottom - top) / 100];
}

function yamlString(value: string) {
  return JSON.stringify(value);
}

export async function prepareYoloDataset(input: YoloDatasetInput) {
  const root = path.resolve(input.artifactRoot);
  const outputDir = path.resolve(input.outputDir);
  const classes = [...new Set(input.classes.map((name) => name.trim()).filter(Boolean))];
  if (!classes.length) throw new Error('目标检测训练至少需要一个类别');

  await rm(outputDir, { recursive: true, force: true });
  for (const split of ['train', 'val', 'test']) {
    await mkdir(path.join(outputDir, 'images', split), { recursive: true });
    await mkdir(path.join(outputDir, 'labels', split), { recursive: true });
  }

  const counts = { train: 0, val: 0, test: 0 };
  for (const image of input.images) {
    const labels = image.annotations.flatMap((annotation) => {
      const classId = classes.indexOf(annotation.label);
      const box = yoloBox(annotation);
      if (classId < 0 || !box || box.some((value) => !Number.isFinite(value) || value <= 0 || value > 1)) return [];
      return [`${classId} ${box.map((value) => value.toFixed(8)).join(' ')}`];
    });
    if (!labels.length) continue;

    const sourcePath = path.resolve(root, image.objectKey);
    if (!sourcePath.startsWith(`${root}${path.sep}`)) throw new Error(`数据集图片路径不合法：${image.filename}`);
    const split = splitName(image.split);
    const extension = path.extname(image.filename).toLowerCase() || '.jpg';
    const stem = `${image.id.replace(/[^a-zA-Z0-9_-]/g, '_')}-${safeStem(image.filename)}`;
    await copyFile(sourcePath, path.join(outputDir, 'images', split, `${stem}${extension}`));
    await writeFile(path.join(outputDir, 'labels', split, `${stem}.txt`), `${labels.join('\n')}\n`);
    counts[split] += 1;
  }

  if (!counts.train) {
    await rm(outputDir, { recursive: true, force: true });
    throw new Error('训练分片没有包含有效目标框的已标注图片');
  }

  const yamlPath = path.join(outputDir, 'dataset.yaml');
  const yaml = [
    `path: ${yamlString(outputDir)}`,
    'train: images/train',
    `val: images/${counts.val ? 'val' : 'train'}`,
    ...(counts.test ? ['test: images/test'] : []),
    `nc: ${classes.length}`,
    'names:',
    ...classes.map((name, index) => `  ${index}: ${yamlString(name)}`),
    '',
  ].join('\n');
  await writeFile(yamlPath, yaml, 'utf8');
  return { yamlPath, classes, counts, imageCount: counts.train + counts.val + counts.test };
}
