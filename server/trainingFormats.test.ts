import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import type { AnnotationRecord, DataFormat, TrainingType } from '../shared/contracts';
import { prepareTrainingFormat } from './trainingFormats';

const rectangle: AnnotationRecord = { id: 'rect-1', label: 'defect', color: '#2383f2', geometry: { type: 'rectangle', x: 10, y: 20, width: 30, height: 40 } };
const polygon: AnnotationRecord = { id: 'poly-1', label: 'defect', color: '#16a085', geometry: { type: 'polygon', points: [{ x: 20, y: 20 }, { x: 80, y: 20 }, { x: 70, y: 80 }, { x: 25, y: 75 }] } };
const keypoints: AnnotationRecord[] = [
  { id: 'point-1', label: 'left', color: '#7357c6', geometry: { type: 'keypoint', x: 25, y: 35, index: 1 } },
  { id: 'point-2', label: 'right', color: '#7357c6', geometry: { type: 'keypoint', x: 75, y: 65, index: 2 } },
];

describe('training standard-format adapters', () => {
  it('materializes and reads every supported training format', async () => {
    const artifactRoot = await mkdtemp(path.join(tmpdir(), 'forge-training-formats-'));
    const sourceDir = path.join(artifactRoot, 'datasets', 'dataset-1');
    await mkdir(sourceDir, { recursive: true });
    const png = new PNG({ width: 32, height: 24 });
    png.data.fill(255);
    await writeFile(path.join(sourceDir, 'sample.png'), PNG.sync.write(png));

    const image = { id: 'image-1', objectKey: 'datasets/dataset-1/sample.png', filename: 'sample.png', mimeType: 'image/png', width: 32, height: 24, split: 'train' as const };
    const dataset = { id: 'dataset-1', name: 'Universal Dataset', version: 'v1', classes: ['defect'] };

    try {
      for (const format of ['YOLO', 'COCO', 'VOC'] as const satisfies readonly DataFormat[]) {
        const outputDir = path.join(artifactRoot, 'training', format.toLowerCase());
        const prepared = await prepareTrainingFormat({ artifactRoot, outputDir, task: 'detection', format, dataset, images: [image], documents: [{ imageId: image.id, annotations: [rectangle] }] });
        expect(prepared).toMatchObject({ format, imageCount: 1, classes: ['defect'] });
        expect(await readFile(prepared.configPath, 'utf8')).toContain('nc: 1');
        if (format !== 'YOLO') {
          const labels = await readdir(path.join(outputDir, 'native', 'labels', 'train'));
          expect(await readFile(path.join(outputDir, 'native', 'labels', 'train', labels[0]), 'utf8')).toMatch(/^0 /);
        }
      }

      for (const format of ['COCO_SEGMENTATION', 'PNG_MASK'] as const satisfies readonly DataFormat[]) {
        const outputDir = path.join(artifactRoot, 'training', format.toLowerCase());
        const prepared = await prepareTrainingFormat({ artifactRoot, outputDir, task: 'segmentation', format, dataset, images: [image], documents: [{ imageId: image.id, annotations: [polygon] }] });
        const manifest = JSON.parse(await readFile(prepared.configPath, 'utf8')) as { task: TrainingType; dataFormat: DataFormat; images: Array<{ maskPath?: string; annotations?: AnnotationRecord[] }> };
        expect(manifest).toMatchObject({ task: 'segmentation', dataFormat: format });
        expect(manifest.images).toHaveLength(1);
        if (format === 'PNG_MASK') expect(await readFile(manifest.images[0].maskPath as string)).not.toHaveLength(0);
        else expect(manifest.images[0].annotations).toHaveLength(1);
      }

      const yoloSegOutput = path.join(artifactRoot, 'training', 'yolo-segmentation');
      const yoloSeg = await prepareTrainingFormat({ artifactRoot, outputDir: yoloSegOutput, task: 'segmentation', format: 'YOLO_SEGMENTATION', dataset, images: [image], documents: [{ imageId: image.id, annotations: [polygon] }] });
      expect(yoloSeg).toMatchObject({ format: 'YOLO_SEGMENTATION', imageCount: 1, classes: ['defect'] });
      expect(await readFile(path.join(yoloSegOutput, 'selected', 'labels', 'train', '000001-sample.txt'), 'utf8')).toBe('0 0.20000000 0.20000000 0.80000000 0.20000000 0.70000000 0.80000000 0.25000000 0.75000000\n');

      const yoloPoseOutput = path.join(artifactRoot, 'training', 'yolo-pose');
      const yoloPose = await prepareTrainingFormat({ artifactRoot, outputDir: yoloPoseOutput, task: 'keypoint', format: 'YOLO_KEYPOINTS', dataset: { ...dataset, name: 'Universal Object' }, images: [image], documents: [{ imageId: image.id, annotations: keypoints }] });
      expect(yoloPose).toMatchObject({ format: 'YOLO_KEYPOINTS', imageCount: 1 });
      expect(await readFile(path.join(yoloPoseOutput, 'selected', 'dataset.yaml'), 'utf8')).toContain('kpt_shape: [2, 3]');
      expect((await readFile(path.join(yoloPoseOutput, 'selected', 'labels', 'train', '000001-sample.txt'), 'utf8')).trim().split(/\s+/)).toEqual(['0', '0.50000000', '0.50000000', '0.50000000', '0.30000000', '0.25000000', '0.35000000', '2.00000000', '0.75000000', '0.65000000', '2.00000000']);

      const keypointOutput = path.join(artifactRoot, 'training', 'coco-keypoints');
      const prepared = await prepareTrainingFormat({ artifactRoot, outputDir: keypointOutput, task: 'keypoint', format: 'COCO_KEYPOINTS', dataset: { ...dataset, classes: ['left', 'right'] }, images: [image], documents: [{ imageId: image.id, annotations: keypoints }] });
      const manifest = JSON.parse(await readFile(prepared.configPath, 'utf8')) as { task: TrainingType; dataFormat: DataFormat; keypointCount: number; images: Array<{ annotations: AnnotationRecord[] }> };
      expect(manifest).toMatchObject({ task: 'keypoint', dataFormat: 'COCO_KEYPOINTS', keypointCount: 2 });
      expect(manifest.images[0].annotations).toHaveLength(2);

      const sdxlOutput = path.join(artifactRoot, 'training', 'image-folder');
      const sdxl = await prepareTrainingFormat({ artifactRoot, outputDir: sdxlOutput, task: 'sdxl', format: 'IMAGE_FOLDER', dataset, images: [image], documents: [{ imageId: image.id, annotations: [], captions: [{ id: 'caption-1', text: 'a scratched metal surface', language: 'en', primary: true, source: 'human' }], imageAttributes: { includeInSdxl: true, tags: ['scratch', 'metal'], crop: { x: 5, y: 10, width: 80, height: 70 } } }] });
      const sdxlManifest = JSON.parse(await readFile(sdxl.configPath, 'utf8')) as { task: TrainingType; dataFormat: DataFormat; images: Array<{ prompt: string; tags: string[]; crop: { x: number } }> };
      expect(sdxl).toMatchObject({ format: 'IMAGE_FOLDER', imageCount: 1 });
      expect(sdxlManifest).toMatchObject({ task: 'sdxl', dataFormat: 'IMAGE_FOLDER' });
      expect(sdxlManifest.images[0]).toMatchObject({ prompt: 'a scratched metal surface', tags: ['scratch', 'metal'], crop: { x: 5 } });
      expect(await readFile(path.join(sdxlOutput, 'selected', 'metadata.jsonl'), 'utf8')).toContain('"file_name":"images/000001-sample.png"');
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });

  it('preserves numeric Pascal VOC class names', async () => {
    const artifactRoot = await mkdtemp(path.join(tmpdir(), 'forge-training-voc-numeric-'));
    const sourceDir = path.join(artifactRoot, 'datasets', 'dataset-1');
    await mkdir(sourceDir, { recursive: true });
    const png = new PNG({ width: 32, height: 24 });
    png.data.fill(255);
    await writeFile(path.join(sourceDir, 'sample.png'), PNG.sync.write(png));

    const image = { id: 'image-1', objectKey: 'datasets/dataset-1/sample.png', filename: 'sample.png', mimeType: 'image/png', width: 32, height: 24, split: 'train' as const };
    try {
      const prepared = await prepareTrainingFormat({
        artifactRoot,
        outputDir: path.join(artifactRoot, 'training', 'voc'),
        task: 'detection',
        format: 'VOC',
        dataset: { id: 'dataset-1', name: 'Numeric Classes', version: 'v1', classes: ['1'] },
        images: [image],
        documents: [{ imageId: image.id, annotations: [{ ...rectangle, label: '1' }] }],
      });
      const labels = await readdir(path.join(artifactRoot, 'training', 'voc', 'native', 'labels', 'train'));
      expect(await readFile(path.join(artifactRoot, 'training', 'voc', 'native', 'labels', 'train', labels[0]), 'utf8')).toMatch(/^0 /);
      expect(prepared.imageCount).toBe(1);
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });
});
