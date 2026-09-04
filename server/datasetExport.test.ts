import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import type { AnnotationRecord } from '../shared/contracts';
import { buildCocoDocument, buildCvatJson, buildCvatXml, buildVocXml, createDatasetExport, renderSegmentationMask, selectAnnotatedExportData, type DimensionedExportImage } from './datasetExport';
import { convertCvatPayload, parseCvatXml, validateCvatPayload } from './cvatExchange';

const image: DimensionedExportImage = { id: 'image-1', objectKey: 'datasets/1/image.png', filename: 'image.png', exportFilename: '000001-image.png', mimeType: 'image/png', width: 200, height: 100, split: 'train', sourcePath: '/data/artifacts/datasets/1/image.png' };
const annotations: AnnotationRecord[] = [
  { id: 'rect-1', label: 'scratch', color: '#2383f2', geometry: { type: 'rectangle', x: 10, y: 20, width: 30, height: 40 } },
  { id: 'poly-1', label: 'dent', color: '#16a085', geometry: { type: 'polygon', points: [{ x: 50, y: 20 }, { x: 80, y: 20 }, { x: 65, y: 70 }] } },
];

describe('dataset format exporters', () => {
  it('blocks CVAT imports until unknown labels are mapped', () => {
    const payload = { images: [{ shapes: [{ type: 'rectangle', label: 'unknown', points: [1, 2, 3, 4] }] }] };
    expect(validateCvatPayload(payload, ['scratch']).valid).toBe(false);
    expect(validateCvatPayload(payload, ['scratch']).errors[0].path).toBe('labelMapping.unknown');
    expect(validateCvatPayload(payload, ['scratch'], { unknown: 'scratch' }).valid).toBe(true);
  });

  it('converts CVAT shapes into platform percentage geometry', () => {
    const result = convertCvatPayload({ images: [{ name: 'image.png', width: 200, height: 100, shapes: [{ type: 'rectangle', label: 'scratch', points: [20, 20, 80, 60] }] }] }, [{ id: 'image-1', datasetId: 'dataset-1', filename: 'image.png', mimeType: 'image/png', split: 'train', width: 200, height: 100, sizeBytes: 10, createdAt: new Date().toISOString() }], ['scratch']);
    expect(result.validation.valid).toBe(true);
    expect(result.documents[0].annotations[0].geometry).toMatchObject({ type: 'rectangle', x: 10, y: 20, width: 30, height: 40 });
    expect(parseCvatXml('<?xml version="1.0"?><annotations><image id="0" name="image.png" width="200" height="100"><box label="scratch" xtl="20" ytl="20" xbr="80" ybr="60"/></image></annotations>').images[0].shapes[0]).toMatchObject({ type: 'rectangle', label: 'scratch' });
  });
  it('builds CVAT JSON and XML with frame metadata and escaped labels', () => {
    const frame = { ...image, sourceAssetId: 'video-1', sourceFrameNumber: 42, sourceTimestampMs: 1400 };
    const cvatJson = buildCvatJson({ dataset: { id: 'dataset-1', name: 'Defects', version: 'v1', classes: ['scratch & dent'] }, images: [frame], documents: [{ imageId: frame.id, annotations: [{ ...annotations[0], label: 'scratch & dent' }] }], versionName: 'release-1' });
    expect(cvatJson.version).toBe('1.1');
    expect(cvatJson.images[0]).toMatchObject({ frame: 42, source_asset_id: 'video-1', source_timestamp_ms: 1400 });
    expect(cvatJson.images[0].shapes[0]).toMatchObject({ label: 'scratch & dent', frame: 42 });
    expect(buildCvatXml({ dataset: { id: 'dataset-1', name: 'Defects & QA', version: 'v1', classes: ['scratch & dent'] }, images: [frame], documents: [{ imageId: frame.id, annotations }] })).toContain('scratch &amp; dent');
  });
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

  it('includes approved empty images when exporting an explicit Job scope', () => {
    const emptyImage = { ...image, id: 'image-2', filename: 'empty.png' };
    const selected = selectAnnotatedExportData([image, emptyImage], [{ imageId: image.id, annotations }, { imageId: emptyImage.id, annotations: [] }], true);

    expect(selected.images.map((item) => item.id)).toEqual([image.id, emptyImage.id]);
    expect(selected.documents).toHaveLength(2);
    expect(selected.excludedImageCount).toBe(0);
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
