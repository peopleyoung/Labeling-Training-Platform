import { ZipArchive } from 'archiver';
import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { imageSize } from 'image-size';
import { PNG } from 'pngjs';
import type { AnnotationDocument, AnnotationRecord, DataFormat } from '../shared/contracts';

export interface ExportImage {
  id: string;
  objectKey: string;
  filename: string;
  mimeType: string;
  width?: number;
  height?: number;
  split: 'train' | 'validation' | 'test';
  sourceAssetId?: string;
  sourceFrameNumber?: number;
  sourceTimestampMs?: number;
}

export interface ExportAnnotationDocument {
  imageId: string;
  annotations: AnnotationRecord[];
  captions?: AnnotationDocument['captions'];
  imageAttributes?: AnnotationDocument['imageAttributes'];
}

export interface DimensionedExportImage extends ExportImage {
  exportFilename: string;
  width: number;
  height: number;
  sourcePath: string;
}

export interface DatasetExportInput {
  artifactRoot: string;
  outputDir: string;
  dataset: { id: string; name: string; version: string; classes: string[] };
  format: DataFormat;
  scope: 'all' | 'train' | 'validation' | 'test';
  versionName: string;
  includeImages: boolean;
  candidateImageCount?: number;
  includeEmptyApprovedImages?: boolean;
  images: ExportImage[];
  documents: ExportAnnotationDocument[];
}

export interface MaterializedDatasetFormat {
  packageDir: string;
  manifestPath: string;
  format: DataFormat;
  classes: string[];
  images: DimensionedExportImage[];
  documents: ExportAnnotationDocument[];
}

export function selectAnnotatedExportData(images: ExportImage[], documents: ExportAnnotationDocument[], includeEmptyImages = false) {
  const annotationsByImage = new Map(documents.map((document) => [document.imageId, document.annotations]));
  const selectedImages = images.filter((image) => includeEmptyImages ? annotationsByImage.has(image.id) : (annotationsByImage.get(image.id)?.length ?? 0) > 0);
  const selectedImageIds = new Set(selectedImages.map((image) => image.id));
  return {
    images: selectedImages,
    documents: documents.filter((document) => selectedImageIds.has(document.imageId) && (includeEmptyImages || document.annotations.length > 0)),
    excludedImageCount: images.length - selectedImages.length,
  };
}

function supportsAnnotation(format: DataFormat, annotation: AnnotationRecord) {
  const type = annotation.geometry.type;
  if (format === 'CVAT_JSON') return ['rectangle', 'polygon', 'polyline', 'ellipse', 'keypoint'].includes(type);
  if (format === 'CVAT_XML') return ['rectangle', 'polygon', 'polyline', 'ellipse'].includes(type);
  if (format === 'IMAGE_FOLDER') return false;
  if (format === 'YOLO_KEYPOINTS') return type === 'keypoint' || type === 'skeleton';
  if (format === 'YOLO_SEGMENTATION') return ['rectangle', 'polygon', 'ellipse'].includes(type);
  if (format === 'COCO_KEYPOINTS') return type === 'keypoint' || type === 'skeleton';
  if (format === 'PNG_MASK') return ['rectangle', 'polygon', 'polyline', 'ellipse'].includes(type);
  if (format === 'COCO_SEGMENTATION') return ['rectangle', 'polygon', 'ellipse'].includes(type);
  return ['rectangle', 'polygon', 'ellipse'].includes(type);
}

export function selectFormatCompatibleExportData(format: DataFormat, images: ExportImage[], documents: ExportAnnotationDocument[], includeEmptyImages = false) {
  const imageIds = new Set(images.map((image) => image.id));
  const unsupported = documents.filter((document) => imageIds.has(document.imageId)).flatMap((document) => document.annotations.filter((annotation) => !supportsAnnotation(format, annotation)).map((annotation) => `${document.imageId}: ${annotation.geometry.type}`));
  if (unsupported.length) throw new Error(`${format} 无法表达 ${unsupported.length} 个标注对象（${unsupported.slice(0, 5).join('、')}），请选择兼容格式`);
  if (format === 'IMAGE_FOLDER') {
    const compatibleDocuments = documents.filter((document) => document.imageAttributes?.includeInSdxl && document.captions?.some((caption) => caption.primary && caption.text.trim()));
    const ids = new Set(compatibleDocuments.map((document) => document.imageId));
    return { images: images.filter((image) => ids.has(image.id)), documents: compatibleDocuments, excludedImageCount: images.filter((image) => !ids.has(image.id)).length };
  }
  const compatibleDocuments = documents.map((document) => ({
    ...document,
    annotations: document.annotations.filter((annotation) => supportsAnnotation(format, annotation)),
  }));
  return selectAnnotatedExportData(images, compatibleDocuments, includeEmptyImages);
}

function safeName(value: string) {
  return value.trim().replace(/[^\p{L}\p{N}._-]+/gu, '_').replace(/^\.+/, '') || 'file';
}

function xml(value: string | number | boolean) {
  return String(value).replace(/[<>&"']/g, (character) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[character] ?? character);
}

function pixel(value: number, length: number) {
  return Math.max(0, Math.min(length, (value / 100) * length));
}

function pointsFor(annotation: AnnotationRecord, width: number, height: number) {
  const geometry = annotation.geometry;
  if (geometry.type === 'rectangle') {
    const left = pixel(geometry.x, width);
    const top = pixel(geometry.y, height);
    const right = pixel(geometry.x + geometry.width, width);
    const bottom = pixel(geometry.y + geometry.height, height);
    return [{ x: left, y: top }, { x: right, y: top }, { x: right, y: bottom }, { x: left, y: bottom }];
  }
  if (geometry.type === 'polygon' || geometry.type === 'polyline' || geometry.type === 'cuboid') return geometry.points.map((point) => ({ x: pixel(point.x, width), y: pixel(point.y, height) }));
  if (geometry.type === 'ellipse') {
    const rotation = geometry.rotation * Math.PI / 180;
    return Array.from({ length: 32 }, (_, index) => {
      const angle = index * Math.PI * 2 / 32;
      const localX = geometry.rx * Math.cos(angle);
      const localY = geometry.ry * Math.sin(angle);
      return { x: pixel(geometry.cx + localX * Math.cos(rotation) - localY * Math.sin(rotation), width), y: pixel(geometry.cy + localX * Math.sin(rotation) + localY * Math.cos(rotation), height) };
    });
  }
  if (geometry.type === 'skeleton') return geometry.points.map((point) => ({ x: pixel(point.x, width), y: pixel(point.y, height) }));
  return [{ x: pixel(geometry.x, width), y: pixel(geometry.y, height) }];
}

function bounds(annotation: AnnotationRecord, width: number, height: number) {
  const points = pointsFor(annotation, width, height);
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  const right = Math.max(...xs);
  const bottom = Math.max(...ys);
  return { left, top, right, bottom, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}

function polygonArea(points: Array<{ x: number; y: number }>) {
  if (points.length < 3) return 1;
  return Math.abs(points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length];
    return sum + point.x * next.y - next.x * point.y;
  }, 0) / 2);
}

function categoryNames(classes: string[], documents: ExportAnnotationDocument[]) {
  return [...new Set([...classes, ...documents.flatMap((document) => document.annotations.map((annotation) => annotation.label)).filter(Boolean)])];
}

export function buildCocoDocument(input: {
  dataset: DatasetExportInput['dataset'];
  images: DimensionedExportImage[];
  documents: ExportAnnotationDocument[];
  scope: DatasetExportInput['scope'];
  versionName: string;
}) {
  const categoryList = categoryNames(input.dataset.classes, input.documents);
  const categoryId = new Map(categoryList.map((name, index) => [name, index + 1]));
  const documents = new Map(input.documents.map((document) => [document.imageId, document.annotations]));
  let annotationId = 1;
  return {
    info: { description: input.dataset.name, version: input.versionName || input.dataset.version, date_created: new Date().toISOString() },
    licenses: [],
    images: input.images.map((image, index) => ({ id: index + 1, file_name: image.exportFilename, width: image.width, height: image.height })),
    categories: categoryList.map((name, index) => ({ id: index + 1, name, supercategory: 'defect' })),
    annotations: input.images.flatMap((image, imageIndex) => (documents.get(image.id) ?? []).map((annotation) => {
      const geometry = annotation.geometry;
      const box = bounds(annotation, image.width, image.height);
      const points = pointsFor(annotation, image.width, image.height);
      return {
        id: annotationId++, image_id: imageIndex + 1, category_id: categoryId.get(annotation.label) ?? 1,
        bbox: [box.left, box.top, box.width, box.height],
        area: geometry.type === 'polygon' || geometry.type === 'ellipse' ? polygonArea(points) : box.width * box.height,
        segmentation: geometry.type === 'polygon' || geometry.type === 'rectangle' || geometry.type === 'ellipse' ? [points.flatMap((point) => [point.x, point.y])] : [],
        iscrowd: 0,
      };
    })),
  };
}

export function buildCocoKeypointsDocument(input: {
  dataset: DatasetExportInput['dataset'];
  images: DimensionedExportImage[];
  documents: ExportAnnotationDocument[];
  versionName: string;
}) {
  const pointRecords = (annotations: AnnotationRecord[]) => annotations.flatMap((annotation) => annotation.geometry.type === 'keypoint' ? [{ ...annotation.geometry, label: annotation.label, visibility: 2 as const }] : annotation.geometry.type === 'skeleton' ? annotation.geometry.points.map((point) => ({ ...point, label: annotation.label })) : []);
  const documents = new Map(input.documents.map((document) => [document.imageId, pointRecords(document.annotations)]));
  const allPoints = input.documents.flatMap((document) => pointRecords(document.annotations));
  const keypointCount = Math.max(...allPoints.map((point) => point.index), 0);
  const names = Array.from({ length: keypointCount }, (_, index) => allPoints.find((point) => point.index === index + 1)?.label || `point_${index + 1}`);
  let annotationId = 1;
  return {
    info: { description: input.dataset.name, version: input.versionName || input.dataset.version, date_created: new Date().toISOString() },
    licenses: [],
    images: input.images.map((image, index) => ({ id: index + 1, file_name: image.exportFilename, width: image.width, height: image.height })),
    categories: [{ id: 1, name: input.dataset.name, supercategory: 'industrial_object', keypoints: names, skeleton: [] }],
    annotations: input.images.map((image, imageIndex) => {
      const points = documents.get(image.id) ?? [];
      const indexed = new Map(points.map((point) => [point.index, point] as const));
      const visiblePoints = [...indexed.values()].filter((point) => point.visibility > 0);
      const xs = visiblePoints.map((point) => pixel(point.x, image.width));
      const ys = visiblePoints.map((point) => pixel(point.y, image.height));
      const left = Math.min(...xs);
      const top = Math.min(...ys);
      const right = Math.max(...xs);
      const bottom = Math.max(...ys);
      const width = Math.max(1, right - left);
      const height = Math.max(1, bottom - top);
      return {
        id: annotationId++, image_id: imageIndex + 1, category_id: 1,
        keypoints: Array.from({ length: keypointCount }, (_, index) => {
          const point = indexed.get(index + 1);
          return point ? [pixel(point.x, image.width), pixel(point.y, image.height), point.visibility] : [0, 0, 0];
        }).flat(),
        num_keypoints: visiblePoints.length,
        bbox: [left, top, width, height], area: width * height, iscrowd: 0,
      };
    }),
  };
}

export function buildCvatJson(input: {
  dataset: DatasetExportInput['dataset'];
  images: DimensionedExportImage[];
  documents: ExportAnnotationDocument[];
  versionName: string;
}) {
  const documents = new Map(input.documents.map((document) => [document.imageId, document.annotations]));
  return {
    version: '1.1',
    name: input.dataset.name,
    versionName: input.versionName || input.dataset.version,
    labels: input.dataset.classes.map((name) => ({ name, attributes: [] })),
    images: input.images.map((image, index) => ({
      id: index,
      name: image.exportFilename,
      width: image.width,
      height: image.height,
      frame: image.sourceFrameNumber ?? index,
      source_asset_id: image.sourceAssetId,
      source_frame_number: image.sourceFrameNumber,
      source_timestamp_ms: image.sourceTimestampMs,
      shapes: (documents.get(image.id) ?? []).map((annotation) => {
        const points = pointsFor(annotation, image.width, image.height);
        return { type: annotation.geometry.type, label: annotation.label, points: points.flatMap((point) => [point.x, point.y]), frame: image.sourceFrameNumber ?? index, attributes: annotation.attributes ?? {} };
      }),
    })),
  };
}

export function buildCvatXml(input: {
  dataset: DatasetExportInput['dataset'];
  images: DimensionedExportImage[];
  documents: ExportAnnotationDocument[];
}) {
  const documents = new Map(input.documents.map((document) => [document.imageId, document.annotations]));
  const shapeXml = (annotation: AnnotationRecord, image: DimensionedExportImage) => {
    const box = bounds(annotation, image.width, image.height);
    const points = pointsFor(annotation, image.width, image.height).map((point) => `${point.x},${point.y}`).join(';');
    const attributes = Object.entries(annotation.attributes ?? {}).map(([name, value]) => `<attribute name="${xml(name)}">${xml(value)}</attribute>`).join('');
    if (annotation.geometry.type === 'rectangle' || annotation.geometry.type === 'ellipse') return `<${annotation.geometry.type === 'rectangle' ? 'box' : 'ellipse'} label="${xml(annotation.label)}" xtl="${box.left}" ytl="${box.top}" xbr="${box.right}" ybr="${box.bottom}" frame="${image.sourceFrameNumber ?? 0}">${attributes}</${annotation.geometry.type === 'rectangle' ? 'box' : 'ellipse'}>`;
    return `<${annotation.geometry.type === 'polyline' ? 'polyline' : 'polygon'} label="${xml(annotation.label)}" points="${xml(points)}" frame="${image.sourceFrameNumber ?? 0}">${attributes}</${annotation.geometry.type === 'polyline' ? 'polyline' : 'polygon'}>`;
  };
  return `<?xml version="1.0" encoding="UTF-8"?><annotations><version>1.1</version><meta><task><name>${xml(input.dataset.name)}</name><labels>${input.dataset.classes.map((name) => `<label><name>${xml(name)}</name></label>`).join('')}</labels></task></meta><images>${input.images.map((image, index) => `<image id="${index}" name="${xml(image.exportFilename)}" width="${image.width}" height="${image.height}">${(documents.get(image.id) ?? []).map((annotation) => shapeXml(annotation, image)).join('')}</image>`).join('')}</images></annotations>`;
}

export function buildVocXml(input: { datasetName: string; image: DimensionedExportImage; annotations: AnnotationRecord[] }) {
  const objects = input.annotations.map((annotation) => {
    const box = bounds(annotation, input.image.width, input.image.height);
    return `  <object>\n    <name>${xml(annotation.label)}</name>\n    <pose>Unspecified</pose>\n    <truncated>0</truncated>\n    <difficult>0</difficult>\n    <bndbox>\n      <xmin>${Math.floor(box.left)}</xmin>\n      <ymin>${Math.floor(box.top)}</ymin>\n      <xmax>${Math.ceil(box.right)}</xmax>\n      <ymax>${Math.ceil(box.bottom)}</ymax>\n    </bndbox>\n  </object>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<annotation>\n  <folder>${xml(input.datasetName)}</folder>\n  <filename>${xml(input.image.exportFilename)}</filename>\n  <size>\n    <width>${input.image.width}</width>\n    <height>${input.image.height}</height>\n    <depth>3</depth>\n  </size>\n  <segmented>${input.annotations.some((annotation) => annotation.geometry.type === 'polygon') ? 1 : 0}</segmented>\n${objects}\n</annotation>\n`;
}

function pointInPolygon(x: number, y: number, points: Array<{ x: number; y: number }>) {
  let inside = false;
  for (let index = 0, previous = points.length - 1; index < points.length; previous = index++) {
    const currentPoint = points[index];
    const previousPoint = points[previous];
    if ((currentPoint.y > y) !== (previousPoint.y > y) && x < ((previousPoint.x - currentPoint.x) * (y - currentPoint.y)) / (previousPoint.y - currentPoint.y) + currentPoint.x) inside = !inside;
  }
  return inside;
}

export function renderSegmentationMask(image: Pick<DimensionedExportImage, 'width' | 'height'>, annotations: AnnotationRecord[], classes: string[]) {
  if (classes.length > 255) throw new Error('Segmentation export supports at most 255 foreground classes');
  const png = new PNG({ width: image.width, height: image.height });
  png.data.fill(0);
  for (let offset = 3; offset < png.data.length; offset += 4) png.data[offset] = 255;
  annotations.forEach((annotation) => {
    const classIndex = classes.indexOf(annotation.label) + 1;
    if (classIndex < 1) return;
    const points = pointsFor(annotation, image.width, image.height);
    const box = bounds(annotation, image.width, image.height);
    for (let y = Math.floor(box.top); y < Math.ceil(box.bottom); y += 1) {
      for (let x = Math.floor(box.left); x < Math.ceil(box.right); x += 1) {
        if ((annotation.geometry.type === 'polygon' || annotation.geometry.type === 'ellipse') && !pointInPolygon(x + 0.5, y + 0.5, points)) continue;
        if (annotation.geometry.type === 'polyline') {
          const radius = Math.max(1, annotation.geometry.strokeWidth * image.width / 200);
          const nearSegment = points.slice(1).some((end, index) => {
            const start = points[index];
            const dx = end.x - start.x;
            const dy = end.y - start.y;
            const lengthSquared = dx * dx + dy * dy || 1;
            const t = Math.max(0, Math.min(1, ((x + 0.5 - start.x) * dx + (y + 0.5 - start.y) * dy) / lengthSquared));
            return Math.hypot(x + 0.5 - (start.x + t * dx), y + 0.5 - (start.y + t * dy)) <= radius;
          });
          if (!nearSegment) continue;
        }
        const offset = (y * image.width + x) * 4;
        png.data[offset] = classIndex;
        png.data[offset + 1] = classIndex;
        png.data[offset + 2] = classIndex;
      }
    }
  });
  return PNG.sync.write(png, { colorType: 0 });
}

async function dimensionImages(artifactRoot: string, images: ExportImage[]) {
  return Promise.all(images.map(async (image, index): Promise<DimensionedExportImage> => {
    const sourcePath = path.resolve(artifactRoot, image.objectKey);
    const root = path.resolve(artifactRoot);
    if (!sourcePath.startsWith(`${root}${path.sep}`)) throw new Error(`Invalid dataset image path: ${image.objectKey}`);
    let width = image.width;
    let height = image.height;
    if (!width || !height) {
      const detected = imageSize(await readFile(sourcePath));
      width = detected.width;
      height = detected.height;
    }
    if (!width || !height) throw new Error(`Unable to determine image dimensions: ${image.filename}`);
    return { ...image, width, height, sourcePath, exportFilename: `${String(index + 1).padStart(6, '0')}-${safeName(image.filename)}` };
  }));
}

function yoloBox(annotation: AnnotationRecord) {
  const geometry = annotation.geometry;
  if (geometry.type === 'keypoint' || geometry.type === 'skeleton' || geometry.type === 'polyline') return null;
  if (geometry.type === 'rectangle') return [geometry.x + geometry.width / 2, geometry.y + geometry.height / 2, geometry.width, geometry.height].map((value) => value / 100);
  const normalizedPoints = pointsFor(annotation, 100, 100);
  const xs = normalizedPoints.map((point) => point.x);
  const ys = normalizedPoints.map((point) => point.y);
  return [(Math.min(...xs) + Math.max(...xs)) / 200, (Math.min(...ys) + Math.max(...ys)) / 200, (Math.max(...xs) - Math.min(...xs)) / 100, (Math.max(...ys) - Math.min(...ys)) / 100];
}

interface YoloKeypointRecord {
  index: number;
  x: number;
  y: number;
  visibility: number;
  label: string;
}

function yoloKeypoints(annotations: AnnotationRecord[]): YoloKeypointRecord[] {
  const records: YoloKeypointRecord[] = [];
  for (const annotation of annotations) {
    if (annotation.geometry.type === 'keypoint') records.push({ index: annotation.geometry.index, x: annotation.geometry.x, y: annotation.geometry.y, visibility: 2, label: annotation.label });
    if (annotation.geometry.type === 'skeleton') records.push(...annotation.geometry.points.map((point) => ({ index: point.index, x: point.x, y: point.y, visibility: Number(point.visibility), label: annotation.label })));
  }
  return records;
}

function yoloSegmentationLine(annotation: AnnotationRecord, classes: string[], width: number, height: number) {
  const classId = classes.indexOf(annotation.label);
  const points = pointsFor(annotation, width, height);
  if (classId < 0 || points.length < 3) return null;
  return [String(classId), ...points.flatMap((point) => [point.x / width, point.y / height].map((value) => value.toFixed(8)))].join(' ');
}

function yoloPoseLine(annotations: AnnotationRecord[], width: number, height: number, keypointCount: number) {
  const points = yoloKeypoints(annotations).filter((point) => point.index > 0 && point.index <= keypointCount && point.visibility > 0);
  if (!points.length) return null;
  const xs = points.map((point) => pixel(point.x, width));
  const ys = points.map((point) => pixel(point.y, height));
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  const right = Math.max(...xs);
  const bottom = Math.max(...ys);
  const boxWidth = Math.max(1, right - left);
  const boxHeight = Math.max(1, bottom - top);
  const indexed = new Map(points.map((point) => [point.index, point] as const));
  const values = [
    0,
    (left + right) / (2 * width),
    (top + bottom) / (2 * height),
    boxWidth / width,
    boxHeight / height,
    ...Array.from({ length: keypointCount }, (_, index) => {
      const point = indexed.get(index + 1);
      return point ? [pixel(point.x, width) / width, pixel(point.y, height) / height, Math.max(0, Math.min(2, point.visibility))] : [0, 0, 0];
    }).flat(),
  ];
  return [String(values[0]), ...values.slice(1).map((value) => value.toFixed(8))].join(' ');
}

function splitName(split: ExportImage['split']) {
  return split === 'validation' ? 'val' : split;
}

export async function materializeDatasetFormat(input: DatasetExportInput, packageDir = input.outputDir): Promise<MaterializedDatasetFormat> {
  const selected = selectFormatCompatibleExportData(input.format, input.images, input.documents, input.includeEmptyApprovedImages);
  if (!selected.images.length) throw new Error(`所选范围没有与 ${input.format} 兼容的已标注图片，无法创建数据包`);
  const images = await dimensionImages(input.artifactRoot, selected.images);
  const documents = new Map(selected.documents.map((document) => [document.imageId, document.annotations]));
  const selectedDocuments = new Map(selected.documents.map((document) => [document.imageId, document]));
  const classes = categoryNames(input.dataset.classes, selected.documents);
  await rm(packageDir, { recursive: true, force: true });
  await mkdir(packageDir, { recursive: true });

  if (['YOLO', 'YOLO_SEGMENTATION', 'YOLO_KEYPOINTS'].includes(input.format)) {
    const isPose = input.format === 'YOLO_KEYPOINTS';
    const yoloClasses = isPose ? [input.dataset.name.trim() || 'object'] : classes;
    const allKeypoints = input.documents.flatMap((document) => yoloKeypoints(document.annotations));
    const keypointCount = Math.max(...allKeypoints.map((point) => point.index), 0);
    const keypointNames = Array.from({ length: keypointCount }, (_, index) => allKeypoints.find((point) => point.index === index + 1)?.label || `point_${index + 1}`);
    for (const split of ['train', 'val', 'test']) {
      await mkdir(path.join(packageDir, 'images', split), { recursive: true });
      await mkdir(path.join(packageDir, 'labels', split), { recursive: true });
    }
    for (const image of images) {
      const split = splitName(image.split);
      const labels = (documents.get(image.id) ?? []).flatMap((annotation) => {
        if (input.format === 'YOLO_SEGMENTATION') {
          const line = yoloSegmentationLine(annotation, yoloClasses, image.width, image.height);
          return line ? [line] : [];
        }
        if (input.format === 'YOLO') {
          const classId = yoloClasses.indexOf(annotation.label);
          const box = yoloBox(annotation);
          return classId >= 0 && box ? [`${classId} ${box.map((value) => value.toFixed(8)).join(' ')}`] : [];
        }
        return [];
      });
      if (isPose) {
        const line = yoloPoseLine(documents.get(image.id) ?? [], image.width, image.height, keypointCount);
        if (line) labels.push(line);
      }
      const stem = path.parse(image.exportFilename).name;
      await writeFile(path.join(packageDir, 'labels', split, `${stem}.txt`), `${labels.join('\n')}\n`);
      if (input.includeImages) await copyFile(image.sourcePath, path.join(packageDir, 'images', split, image.exportFilename));
    }
    const counts = Object.fromEntries(['train', 'val', 'test'].map((split) => [split, images.filter((image) => splitName(image.split) === split).length]));
    await writeFile(path.join(packageDir, 'dataset.yaml'), [`path: ${JSON.stringify(packageDir)}`, 'train: images/train', `val: images/${counts.val ? 'val' : 'train'}`, ...(counts.test ? ['test: images/test'] : []), ...(isPose ? [`kpt_shape: [${keypointCount}, 3]`] : []), `nc: ${yoloClasses.length}`, 'names:', ...yoloClasses.map((name, index) => `  ${index}: ${JSON.stringify(name)}`), ''].join('\n'));
  } else if (input.format === 'COCO' || input.format === 'COCO_SEGMENTATION') {
    await mkdir(path.join(packageDir, 'annotations'), { recursive: true });
    const coco = buildCocoDocument({ dataset: input.dataset, images, documents: selected.documents, scope: input.scope, versionName: input.versionName });
    await writeFile(path.join(packageDir, 'annotations', `instances_${safeName(input.scope)}.json`), JSON.stringify(coco, null, 2));
  } else if (input.format === 'COCO_KEYPOINTS') {
    await mkdir(path.join(packageDir, 'annotations'), { recursive: true });
    const coco = buildCocoKeypointsDocument({ dataset: input.dataset, images, documents: selected.documents, versionName: input.versionName });
    await writeFile(path.join(packageDir, 'annotations', `keypoints_${safeName(input.scope)}.json`), JSON.stringify(coco, null, 2));
  } else if (input.format === 'CVAT_JSON' || input.format === 'CVAT_XML') {
    await mkdir(path.join(packageDir, 'annotations'), { recursive: true });
    const content = input.format === 'CVAT_JSON'
      ? JSON.stringify(buildCvatJson({ dataset: input.dataset, images, documents: selected.documents, versionName: input.versionName }), null, 2)
      : buildCvatXml({ dataset: input.dataset, images, documents: selected.documents });
    await writeFile(path.join(packageDir, 'annotations', input.format === 'CVAT_JSON' ? 'annotations.json' : 'annotations.xml'), content);
  } else if (input.format === 'VOC') {
    await Promise.all(['Annotations', 'ImageSets/Main'].map((directory) => mkdir(path.join(packageDir, directory), { recursive: true })));
    const setNames: string[] = [];
    for (const image of images) {
      const stem = path.parse(image.exportFilename).name;
      setNames.push(stem);
      await writeFile(path.join(packageDir, 'Annotations', `${stem}.xml`), buildVocXml({ datasetName: input.dataset.name, image, annotations: documents.get(image.id) ?? [] }));
    }
    await writeFile(path.join(packageDir, 'ImageSets', 'Main', `${safeName(input.scope)}.txt`), `${setNames.join('\n')}\n`);
  } else if (input.format === 'IMAGE_FOLDER') {
    const metadata = images.map((image) => {
      const document = selectedDocuments.get(image.id);
      const caption = document?.captions?.find((item) => item.primary && item.text.trim());
      if (!caption) throw new Error(`图片 ${image.filename} 缺少主 Caption`);
      return JSON.stringify({ file_name: `images/${image.exportFilename}`, text: caption.text.trim(), split: image.split, tags: document?.imageAttributes?.tags ?? [], crop: document?.imageAttributes?.crop });
    });
    await writeFile(path.join(packageDir, 'metadata.jsonl'), `${metadata.join('\n')}\n`);
  } else {
    await mkdir(path.join(packageDir, 'masks'), { recursive: true });
    await writeFile(path.join(packageDir, 'classes.json'), JSON.stringify({ background: 0, classes: Object.fromEntries(classes.map((name, index) => [name, index + 1])) }, null, 2));
    for (const image of images) await writeFile(path.join(packageDir, 'masks', `${path.parse(image.exportFilename).name}.png`), renderSegmentationMask(image, documents.get(image.id) ?? [], classes));
  }

  if (input.includeImages && !['YOLO', 'YOLO_SEGMENTATION', 'YOLO_KEYPOINTS'].includes(input.format)) {
    await mkdir(path.join(packageDir, 'images'), { recursive: true });
    await Promise.all(images.map((image) => copyFile(image.sourcePath, path.join(packageDir, 'images', image.exportFilename))));
  }
  const candidateImageCount = input.candidateImageCount ?? input.images.length;
  const manifestPath = path.join(packageDir, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify({
    version: 2, format: input.format, dataset: input.dataset, scope: input.scope, versionName: input.versionName,
    includeImages: input.includeImages, annotatedOnly: !input.includeEmptyApprovedImages, imageCount: images.length,
    excludedUnannotatedImageCount: Math.max(0, candidateImageCount - images.length),
    images: images.map((image) => ({ id: image.id, file: image.exportFilename, split: image.split, width: image.width, height: image.height })),
    generatedAt: new Date().toISOString(),
  }, null, 2));
  return { packageDir, manifestPath, format: input.format, classes, images, documents: selected.documents };
}

async function zipDirectory(sourceDir: string, targetPath: string) {
  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(targetPath);
    const archive = new ZipArchive({ zlib: { level: 9 } });
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(sourceDir, false);
    void archive.finalize();
  });
}

export async function createDatasetExport(input: DatasetExportInput) {
  const packageDir = path.join(input.outputDir, 'package');
  const archiveName = `${safeName(input.dataset.name)}-${safeName(input.versionName || input.dataset.version)}-${input.format.toLowerCase()}.zip`;
  const archivePath = path.join(input.outputDir, archiveName);
  try {
    await materializeDatasetFormat(input, packageDir);
    await zipDirectory(packageDir, archivePath);
    return archivePath;
  } finally {
    await rm(packageDir, { recursive: true, force: true });
  }
}
