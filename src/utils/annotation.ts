export interface NormalizedPoint {
  x: number;
  y: number;
}

export interface CanvasBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface RectangleBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface EllipseBounds {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  rotation: number;
}

export type RectangleHandle = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw';

const clamp = (value: number, minimum: number, maximum: number) => Math.max(minimum, Math.min(maximum, value));

export function normalizeCanvasPoint(clientX: number, clientY: number, bounds: CanvasBounds): NormalizedPoint {
  const x = bounds.width > 0 ? ((clientX - bounds.left) / bounds.width) * 100 : 0;
  const y = bounds.height > 0 ? ((clientY - bounds.top) / bounds.height) * 100 : 0;
  return {
    x: Math.max(0, Math.min(100, x)),
    y: Math.max(0, Math.min(100, y)),
  };
}

export function rectangleFromPoints(start: NormalizedPoint, end: NormalizedPoint) {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
}

export function moveRectangle(rectangle: RectangleBounds, delta: NormalizedPoint): RectangleBounds {
  return {
    ...rectangle,
    x: clamp(rectangle.x + delta.x, 0, 100 - rectangle.width),
    y: clamp(rectangle.y + delta.y, 0, 100 - rectangle.height),
  };
}

export function resizeRectangle(rectangle: RectangleBounds, handle: RectangleHandle, point: NormalizedPoint, minimumSize = 1.5): RectangleBounds {
  let left = rectangle.x;
  let top = rectangle.y;
  let right = rectangle.x + rectangle.width;
  let bottom = rectangle.y + rectangle.height;

  if (handle.includes('w')) left = clamp(point.x, 0, right - minimumSize);
  if (handle.includes('e')) right = clamp(point.x, left + minimumSize, 100);
  if (handle.includes('n')) top = clamp(point.y, 0, bottom - minimumSize);
  if (handle.includes('s')) bottom = clamp(point.y, top + minimumSize, 100);

  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function movePoints<T extends NormalizedPoint>(points: T[], delta: NormalizedPoint): T[] {
  if (!points.length) return [];
  const minX = Math.min(...points.map((point) => point.x));
  const maxX = Math.max(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const maxY = Math.max(...points.map((point) => point.y));
  const dx = clamp(delta.x, -minX, 100 - maxX);
  const dy = clamp(delta.y, -minY, 100 - maxY);
  return points.map((point) => ({ ...point, x: point.x + dx, y: point.y + dy }));
}

export function ellipseFromPoints(start: NormalizedPoint, end: NormalizedPoint): EllipseBounds {
  return { cx: (start.x + end.x) / 2, cy: (start.y + end.y) / 2, rx: Math.abs(end.x - start.x) / 2, ry: Math.abs(end.y - start.y) / 2, rotation: 0 };
}

export function moveEllipse(ellipse: EllipseBounds, delta: NormalizedPoint): EllipseBounds {
  return { ...ellipse, cx: clamp(ellipse.cx + delta.x, ellipse.rx, 100 - ellipse.rx), cy: clamp(ellipse.cy + delta.y, ellipse.ry, 100 - ellipse.ry) };
}
