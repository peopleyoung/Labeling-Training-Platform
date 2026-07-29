import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareYoloDataset } from './yoloDataset';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixtureRoot() {
  const root = await mkdtemp(join(tmpdir(), 'forge-yolo-data-'));
  roots.push(root);
  await mkdir(join(root, 'datasets'), { recursive: true });
  await writeFile(join(root, 'datasets', 'part.png'), Buffer.from('image'));
  return root;
}

describe('YOLO dataset preparation', () => {
  it('copies only usable annotated images and writes normalized labels', async () => {
    const root = await fixtureRoot();
    const outputDir = join(root, 'runtime', 'job-1');
    const result = await prepareYoloDataset({
      artifactRoot: root,
      outputDir,
      classes: ['scratch'],
      images: [
        { id: 'image-1', objectKey: 'datasets/part.png', filename: 'part.png', split: 'train', annotations: [{ id: 'box-1', label: 'scratch', color: '#1677ff', geometry: { type: 'rectangle', x: 10, y: 20, width: 30, height: 40 } }] },
        { id: 'image-2', objectKey: 'datasets/missing.png', filename: 'missing.png', split: 'train', annotations: [] },
      ],
    });

    expect(result.counts).toEqual({ train: 1, val: 0, test: 0 });
    expect(await readFile(join(outputDir, 'labels', 'train', 'image-1-part.txt'), 'utf8')).toBe('0 0.25000000 0.40000000 0.30000000 0.40000000\n');
    expect(await stat(join(outputDir, 'images', 'train', 'image-1-part.png'))).toBeTruthy();
    expect(await readFile(result.yamlPath, 'utf8')).toContain('val: images/train');
  });

  it('rejects a dataset without usable training boxes', async () => {
    const root = await fixtureRoot();
    await expect(prepareYoloDataset({ artifactRoot: root, outputDir: join(root, 'runtime'), classes: ['scratch'], images: [{ id: 'image-1', objectKey: 'datasets/part.png', filename: 'part.png', split: 'validation', annotations: [{ id: 'point-1', label: 'scratch', color: '#1677ff', geometry: { type: 'keypoint', x: 50, y: 50, index: 1 } }] }] })).rejects.toThrow('训练分片没有包含有效目标框');
  });
});
