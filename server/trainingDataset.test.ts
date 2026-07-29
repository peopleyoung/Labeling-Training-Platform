import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareStructuredTrainingDataset } from './trainingDataset';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe('structured training dataset', () => {
  it('filters annotations and records segmentation and keypoint metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-structured-data-'));
    roots.push(root);
    await mkdir(join(root, 'datasets'), { recursive: true });
    await writeFile(join(root, 'datasets', 'part.png'), 'image');
    const annotations = [
      { id: 'polygon', label: 'scratch', color: '#1677ff', geometry: { type: 'polygon' as const, points: [{ x: 10, y: 10 }, { x: 50, y: 10 }, { x: 50, y: 50 }] } },
      { id: 'point', label: 'joint', color: '#1677ff', geometry: { type: 'keypoint' as const, x: 25, y: 30, index: 3 } },
    ];
    const common = { artifactRoot: root, classes: ['scratch'], images: [{ id: 'image-1', objectKey: 'datasets/part.png', filename: 'part.png', split: 'train' as const, annotations }] };
    const segmentation = await prepareStructuredTrainingDataset({ ...common, task: 'segmentation', outputDir: join(root, 'runtime', 'segmentation') });
    const segmentationManifest = JSON.parse(await readFile(segmentation.manifestPath, 'utf8'));
    expect(segmentationManifest.images[0].annotations).toHaveLength(1);
    const keypoint = await prepareStructuredTrainingDataset({ ...common, task: 'keypoint', classes: ['joint'], outputDir: join(root, 'runtime', 'keypoint') });
    expect(keypoint.keypointCount).toBe(3);
  });

  it('rejects missing train samples and escaped image paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-structured-data-'));
    roots.push(root);
    const image = { id: 'image-1', objectKey: '../escape.png', filename: 'escape.png', split: 'train' as const, annotations: [] };
    await expect(prepareStructuredTrainingDataset({ artifactRoot: root, outputDir: join(root, 'runtime'), task: 'sdxl', classes: [], images: [image] })).rejects.toThrow('路径不合法');
    await expect(prepareStructuredTrainingDataset({ artifactRoot: root, outputDir: join(root, 'runtime'), task: 'segmentation', classes: ['scratch'], images: [] })).rejects.toThrow('训练分片');
  });
});
