import type { AnnotationGeometry, AnnotationRecord, DatasetImage } from '../../types';

export interface CanvasSize {
  width: number;
  height: number;
}

export interface CanvasPoint {
  x: number;
  y: number;
}

export function canvasSizeForImage(image: Pick<DatasetImage, 'width' | 'height'> | undefined): CanvasSize {
  return {
    width: image?.width && image.width > 0 ? image.width : 100,
    height: image?.height && image.height > 0 ? image.height : 100,
  };
}

export function clampPoint(point: CanvasPoint, size: CanvasSize): CanvasPoint {
  return {
    x: Math.max(0, Math.min(size.width, point.x)),
    y: Math.max(0, Math.min(size.height, point.y)),
  };
}

function toCanvasPoint(point: CanvasPoint, size: CanvasSize): CanvasPoint {
  return { x: (point.x / 100) * size.width, y: (point.y / 100) * size.height };
}

function toStoredPoint(point: CanvasPoint, size: CanvasSize): CanvasPoint {
  return { x: (point.x / size.width) * 100, y: (point.y / size.height) * 100 };
}

function mapGeometry(geometry: AnnotationGeometry, mapPoint: (point: CanvasPoint) => CanvasPoint, size: CanvasSize): AnnotationGeometry {
  if (geometry.type === 'rectangle') return { ...geometry, x: (geometry.x / 100) * size.width, y: (geometry.y / 100) * size.height, width: (geometry.width / 100) * size.width, height: (geometry.height / 100) * size.height };
  if (geometry.type === 'polygon' || geometry.type === 'polyline' || geometry.type === 'cuboid') return { ...geometry, points: geometry.points.map(mapPoint) };
  if (geometry.type === 'keypoint') return { ...geometry, ...mapPoint(geometry) };
  if (geometry.type === 'ellipse') return { ...geometry, cx: (geometry.cx / 100) * size.width, cy: (geometry.cy / 100) * size.height, rx: (geometry.rx / 100) * size.width, ry: (geometry.ry / 100) * size.height };
  return { ...geometry, points: geometry.points.map((point) => ({ ...point, ...mapPoint(point) })) };
}

function mapStoredGeometry(geometry: AnnotationGeometry, mapPoint: (point: CanvasPoint) => CanvasPoint, size: CanvasSize): AnnotationGeometry {
  if (geometry.type === 'rectangle') return { ...geometry, x: (geometry.x / size.width) * 100, y: (geometry.y / size.height) * 100, width: (geometry.width / size.width) * 100, height: (geometry.height / size.height) * 100 };
  if (geometry.type === 'polygon' || geometry.type === 'polyline' || geometry.type === 'cuboid') return { ...geometry, points: geometry.points.map(mapPoint) };
  if (geometry.type === 'keypoint') return { ...geometry, ...mapPoint(geometry) };
  if (geometry.type === 'ellipse') return { ...geometry, cx: (geometry.cx / size.width) * 100, cy: (geometry.cy / size.height) * 100, rx: (geometry.rx / size.width) * 100, ry: (geometry.ry / size.height) * 100 };
  return { ...geometry, points: geometry.points.map((point) => ({ ...point, ...mapPoint(point) })) };
}

export function toCanvasShape(record: AnnotationRecord, size: CanvasSize): AnnotationRecord {
  return { ...structuredClone(record), geometry: mapGeometry(record.geometry, (point) => toCanvasPoint(point, size), size) };
}

export function toAnnotationRecord(shape: AnnotationRecord, size: CanvasSize): AnnotationRecord {
  return { ...structuredClone(shape), geometry: mapStoredGeometry(shape.geometry, (point) => toStoredPoint(point, size), size) };
}

export function translateShape(shape: AnnotationRecord, delta: CanvasPoint, size: CanvasSize): AnnotationRecord {
  const geometry = shape.geometry;
  if (geometry.type === 'rectangle') {
    return { ...shape, geometry: { ...geometry, x: Math.max(0, Math.min(size.width - geometry.width, geometry.x + delta.x)), y: Math.max(0, Math.min(size.height - geometry.height, geometry.y + delta.y)) } };
  }
  if (geometry.type === 'keypoint') return { ...shape, geometry: { ...geometry, ...clampPoint({ x: geometry.x + delta.x, y: geometry.y + delta.y }, size) } };
  if (geometry.type === 'skeleton') return { ...shape, geometry: { ...geometry, points: geometry.points.map((point) => ({ ...point, ...clampPoint({ x: point.x + delta.x, y: point.y + delta.y }, size) })) } };
  if ('points' in geometry) return { ...shape, geometry: { ...geometry, points: geometry.points.map((point) => clampPoint({ x: point.x + delta.x, y: point.y + delta.y }, size)) } };
  return shape;
}

