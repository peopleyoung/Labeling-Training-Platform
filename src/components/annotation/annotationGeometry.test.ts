import { describe, expect, it } from 'vitest';
import type { AnnotationRecord } from '../../types';
import { canvasSizeForImage, toAnnotationRecord, toCanvasShape, translateShape } from './annotationGeometry';

describe('annotation geometry conversion', () => {
  it('converts normalized rectangles into image pixels and back', () => {
    const imageSize = canvasSizeForImage({ width: 1920, height: 1080 });
    const record: AnnotationRecord = { id: 'box-1', label: 'senior', color: '#ff6a4d', geometry: { type: 'rectangle', x: 10, y: 20, width: 30, height: 40 } };

    const canvasShape = toCanvasShape(record, imageSize);
    expect(canvasShape.geometry).toEqual({ type: 'rectangle', x: 192, y: 216, width: 576, height: 432 });
    expect(toAnnotationRecord(canvasShape, imageSize)).toEqual(record);
  });

  it('preserves multi-point geometry at the serialization boundary', () => {
    const imageSize = canvasSizeForImage({ width: 1920, height: 1080 });
    const record: AnnotationRecord = { id: 'poly-1', label: 'senior', color: '#ff6a4d', geometry: { type: 'polygon', points: [{ x: 10, y: 20 }, { x: 50, y: 20 }, { x: 30, y: 80 }] } };

    expect(toAnnotationRecord(toCanvasShape(record, imageSize), imageSize)).toEqual(record);
  });

  it('keeps translated shapes within the image bounds', () => {
    const imageSize = canvasSizeForImage({ width: 1920, height: 1080 });
    const record: AnnotationRecord = { id: 'box-1', label: 'senior', color: '#ff6a4d', geometry: { type: 'rectangle', x: 10, y: 20, width: 30, height: 40 } };
    const moved = translateShape(toCanvasShape(record, imageSize), { x: 2000, y: 2000 }, imageSize);

    expect(moved.geometry).toEqual({ type: 'rectangle', x: 1344, y: 648, width: 576, height: 432 });
  });
});

