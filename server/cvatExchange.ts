import { XMLParser } from 'fast-xml-parser';
import { randomUUID } from 'node:crypto';
import type { AnnotationType } from '../shared/contracts';
import type { AnnotationRecord, DatasetImage } from '../shared/contracts';

const supportedShapes = new Set<AnnotationType>(['rectangle', 'polygon', 'polyline', 'ellipse', 'keypoint', 'skeleton']);

export interface CvatValidationResult {
  valid: boolean;
  labels: string[];
  unknownLabels: string[];
  errors: Array<{ path: string; message: string }>;
}

function shapeLabel(shape: Record<string, unknown>) { return typeof shape.label === 'string' ? shape.label.trim() : ''; }

export function validateCvatPayload(payload: unknown, knownLabels: string[], mapping: Record<string, string> = {}): CvatValidationResult {
  const errors: Array<{ path: string; message: string }> = [];
  const labels = new Set<string>();
  const images = Array.isArray((payload as { images?: unknown })?.images) ? (payload as { images: unknown[] }).images : [];
  if (!images.length) errors.push({ path: 'images', message: 'CVAT 数据不包含任何图片或帧' });
  images.forEach((image, imageIndex) => {
    const shapes = Array.isArray((image as { shapes?: unknown })?.shapes) ? (image as { shapes: unknown[] }).shapes : [];
    shapes.forEach((shape, shapeIndex) => {
      const record = shape as Record<string, unknown>;
      const label = shapeLabel(record);
      if (!label) errors.push({ path: `images[${imageIndex}].shapes[${shapeIndex}].label`, message: '标注缺少标签' });
      else labels.add(label);
      if (typeof record.type !== 'string' || !supportedShapes.has(record.type as AnnotationType)) errors.push({ path: `images[${imageIndex}].shapes[${shapeIndex}].type`, message: `不支持的形状类型：${String(record.type)}` });
      if (!Array.isArray(record.points) || record.points.some((point) => typeof point !== 'number' || !Number.isFinite(point))) errors.push({ path: `images[${imageIndex}].shapes[${shapeIndex}].points`, message: 'points 必须是有限数字数组' });
    });
  });
  const unknownLabels = [...labels].filter((label) => !knownLabels.includes(label));
  unknownLabels.forEach((label) => {
    if (!mapping[label] || !knownLabels.includes(mapping[label])) errors.push({ path: `labelMapping.${label}`, message: `未知标签“${label}”必须映射到现有标签` });
  });
  return { valid: errors.length === 0, labels: [...labels], unknownLabels, errors };
}

export function parseCvatXml(content: string) {
  const parsed = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' }).parse(content) as { annotations?: { image?: unknown | unknown[] } };
  const rawImages = parsed.annotations?.image;
  const images = (Array.isArray(rawImages) ? rawImages : rawImages ? [rawImages] : []).map((image) => {
    const record = image as Record<string, unknown>;
    const rawShapes = ['box', 'polygon', 'polyline', 'ellipse', 'points'].flatMap((key) => {
      const values = Array.isArray(record[key]) ? record[key] : record[key] ? [record[key]] : [];
      return values.map((value) => {
        const shape = value as Record<string, string>;
        const rawAttributes = Array.isArray(shape.attribute) ? shape.attribute : shape.attribute ? [shape.attribute] : [];
        const attributes = Object.fromEntries(rawAttributes.map((attribute) => { const item = attribute as Record<string, unknown>; return [String(item.name ?? ''), String(item['#text'] ?? item.value ?? '')]; }).filter(([name]) => name));
        if (key === 'box' || key === 'ellipse') return { type: key === 'box' ? 'rectangle' : key, label: shape.label, points: [Number(shape.xtl), Number(shape.ytl), Number(shape.xbr), Number(shape.ybr)], attributes };
        return { type: key === 'points' ? 'polygon' : key, label: shape.label, points: String(shape.points ?? '').split(/[;,]/).map(Number), attributes };
      });
    });
    return { name: record.name, width: Number(record.width), height: Number(record.height), shapes: rawShapes };
  });
  return { images };
}

export function convertCvatPayload(payload: unknown, images: DatasetImage[], knownLabels: string[], mapping: Record<string, string> = {}) {
  const validation = validateCvatPayload(payload, knownLabels, mapping);
  if (!validation.valid) return { validation, documents: [] as Array<{ imageId: string; annotations: AnnotationRecord[] }> };
  const imageByName = new Map(images.map((image) => [image.filename, image]));
  const documents: Array<{ imageId: string; annotations: AnnotationRecord[] }> = [];
  for (const image of ((payload as { images: Array<Record<string, unknown>> }).images ?? [])) {
    const target = imageByName.get(String(image.name ?? ''));
    if (!target) continue;
    const width = target.width || Number(image.width) || 1;
    const height = target.height || Number(image.height) || 1;
    const annotations = ((image.shapes as Array<Record<string, unknown>>) ?? []).flatMap((shape): AnnotationRecord[] => {
      const label = mapping[String(shape.label)] || String(shape.label);
      const points = (shape.points as number[]).map(Number);
      const type = String(shape.type);
      const percent = (value: number, size: number) => Math.max(0, Math.min(100, value / size * 100));
      let geometry: AnnotationRecord['geometry'];
      if (type === 'rectangle' && points.length >= 4) geometry = { type: 'rectangle', x: percent(points[0], width), y: percent(points[1], height), width: percent(points[2] - points[0], width), height: percent(points[3] - points[1], height) };
      else if ((type === 'polygon' || type === 'polyline') && points.length >= 4) geometry = { type, points: Array.from({ length: Math.floor(points.length / 2) }, (_, index) => ({ x: percent(points[index * 2], width), y: percent(points[index * 2 + 1], height) })), ...(type === 'polyline' ? { strokeWidth: 1 } : {}) } as AnnotationRecord['geometry'];
      else if (type === 'ellipse' && points.length >= 4) geometry = { type: 'ellipse', cx: percent((points[0] + points[2]) / 2, width), cy: percent((points[1] + points[3]) / 2, height), rx: percent(Math.abs(points[2] - points[0]) / 2, width), ry: percent(Math.abs(points[3] - points[1]) / 2, height), rotation: 0 };
      else if (type === 'keypoint' && points.length >= 2) geometry = { type: 'keypoint', x: percent(points[0], width), y: percent(points[1], height), index: 1 };
      else if (type === 'skeleton' && points.length >= 2) geometry = { type: 'skeleton', points: Array.from({ length: Math.floor(points.length / 2) }, (_, index) => ({ x: percent(points[index * 2], width), y: percent(points[index * 2 + 1], height), index: index + 1, visibility: 2 })), edges: [] };
      else return [];
      return [{ id: `cvat-${randomUUID()}`, label, color: '#2383f2', geometry, attributes: typeof shape.attributes === 'object' && shape.attributes ? shape.attributes as Record<string, string | number | boolean> : undefined }];
    });
    documents.push({ imageId: target.id, annotations });
  }
  return { validation, documents };
}
