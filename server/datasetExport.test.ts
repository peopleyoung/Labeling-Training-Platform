import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import type { AnnotationRecord } from '../shared/contracts';
import { buildCocoDocument, buildVocXml, createDatasetExport, renderSegmentationMask, selectAnnotatedExportData, type DimensionedExportImage } from './datasetExport';

const image: DimensionedExportImage = { id: 'image-1', objectKey: 'datasets/1/image.png', filename: 'image.png', exportFilename: '000001-image.png', mimeType: 'image/png', width: 200, height: 100, split: 'train', sourcePath: '/data/artifacts/datasets/1/image.png' };
const annotations: AnnotationRecord[] = [
  { id: 'rect-1', label: 'scratch', color: '#2383f2', geometry: { type: 'rectangle', x: 10, y: 20, width: 30, height: 40 } },
  { id: 'poly-1', label: 'dent', color: '#16a085', geometry: { type: 'polygon', points: [{ x: 50, y: 20 }, { x: 80, y: 20 }, { x: 65, y: 70 }] } },
];

describe('dataset format exporters', () => {
  it('builds pixel-based COCO categories, boxes, and polygon segmentation', () => {
    const coco = buildCocoDocument({ dataset: { id: 'dataset-1', name: 'Defects', version: 'v1', classes: ['scratch', 'dent'] }, images: [image], documents: [{ imageId: image.id, annotations }], scope: 'train', versionName: 'release-1' });
    expect(coco.images[0]).toMatchObject({ width: 200, height: 100, file_name: image.exportFilename });
    expect(coco.categories.map((category) => category.name)).toEqual(['scratch', 'dent']);
    expect(coco.annotations[0]).toMatchObject({ category_id: 1, bbox: [20, 20, 60, 40], area: 2400 });
    expect(coco.annotations[1].segmentation[0]).toHaveLength(6);
  });

  it('builds Pascal VOC XML with escaped labels and pixel bounds', () => {
    const content = buildVocXml({ datasetName: 'Line & Cell', image, annotations: [{ ...annotations[0], label: 'scratch & burr' }] });
    expect(content).toContain('<folder>Line &amp; Cell</folder>');
    expect(content).toContain('<name>scratch &amp; burr</name>');
    expect(content).toContain('<xmin>20</xmin>');
    expect(content).toContain('<ymax>60</ymax>');
  });

  it('renders indexed grayscale segmentation masks', () => {
    const mask = PNG.sync.read(renderSegmentationMask({ width: 20, height: 10 }, [annotations[0]], ['scratch']));
    const inside = (20 * 3 + 3) * 4;
    const outside = 0;
    expect(mask.data[inside]).toBe(1);
    expect(mask.data[outside]).toBe(0);
  });

  it('selects only images with at least one annotation', () => {
    const unannotatedImage = { ...image, id: 'image-2', filename: 'unannotated.png' };
    const emptyDocument = { imageId: unannotatedImage.id, annotations: [] };

    const selected = selectAnnotatedExportData([image, unannotatedImage], [{ imageId: image.id, annotations }, emptyDocument]);

    expect(selected.images.map((item) => item.id)).toEqual([image.id]);
    expect(selected.documents.map((document) => document.imageId)).toEqual([image.id]);
    expect(selected.excludedImageCount).toBe(1);
  });

  it('rejects an export when the selected scope has no annotated images', async () => {
    await expect(createDatasetExport({ artifactRoot: '/tmp', outputDir: '/tmp/export', dataset: { id: 'dataset-1', name: 'Defects', version: 'v1', classes: ['scratch'] }, format: 'COCO', scope: 'all', versionName: 'empty', includeImages: true, images: [{ ...image, id: 'image-2' }], documents: [] })).rejects.toThrow('所选范围没有与 COCO 兼容的已标注图片');
  });

  it('creates a real ZIP artifact and removes its staging directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-exporter-'));
    const sourceDir = join(root, 'datasets', 'dataset-1');
    const outputDir = join(root, 'exports', 'export-1');
    await mkdir(sourceDir, { recursive: true });
    await mkdir(outputDir, { recursive: true });
    const sourcePng = new PNG({ width: 20, height: 10 });
    sourcePng.data.fill(255);
    await writeFile(join(sourceDir, 'image.png'), PNG.sync.write(sourcePng));
    await writeFile(join(sourceDir, 'unannotated.png'), PNG.sync.write(sourcePng));
    try {
      const archivePath = await createDatasetExport({ artifactRoot: root, outputDir, dataset: { id: 'dataset-1', name: '缺陷数据', version: 'v1', classes: ['scratch'] }, format: 'COCO', scope: 'train', versionName: 'release-1', includeImages: true, candidateImageCount: 2, images: [{ id: 'image-1', objectKey: 'datasets/dataset-1/image.png', filename: 'image.png', mimeType: 'image/png', split: 'train' }, { id: 'image-2', objectKey: 'datasets/dataset-1/unannotated.png', filename: 'unannotated.png', mimeType: 'image/png', split: 'train' }], documents: [{ imageId: 'image-1', annotations: [annotations[0]] }] });
      const bytes = await readFile(archivePath);
      expect(bytes.subarray(0, 2).toString()).toBe('PK');
      expect(bytes.toString('latin1')).not.toContain('unannotated.png');
      expect(await readdir(outputDir)).toEqual(['缺陷数据-release-1-coco.zip']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
