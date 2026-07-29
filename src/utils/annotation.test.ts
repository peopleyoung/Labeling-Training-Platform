import { describe, expect, it } from 'vitest';
import { ellipseFromPoints, moveEllipse, movePoints, moveRectangle, normalizeCanvasPoint, rectangleFromPoints, resizeRectangle } from './annotation';

describe('annotation geometry', () => {
  it('normalizes pointer coordinates to a percentage view box', () => {
    expect(normalizeCanvasPoint(300, 250, { left: 100, top: 50, width: 400, height: 400 })).toEqual({ x: 50, y: 50 });
  });

  it('clamps points outside the image bounds', () => {
    expect(normalizeCanvasPoint(0, 900, { left: 100, top: 50, width: 400, height: 400 })).toEqual({ x: 0, y: 100 });
  });

  it('builds a positive rectangle when dragging up and left', () => {
    expect(rectangleFromPoints({ x: 70, y: 80 }, { x: 25, y: 30 })).toEqual({ x: 25, y: 30, width: 45, height: 50 });
  });

  it('moves a rectangle without allowing it to leave the image', () => {
    expect(moveRectangle({ x: 70, y: 10, width: 25, height: 20 }, { x: 20, y: -30 })).toEqual({ x: 75, y: 0, width: 25, height: 20 });
  });

  it('resizes a rectangle from a corner and preserves its minimum size', () => {
    expect(resizeRectangle({ x: 20, y: 20, width: 40, height: 30 }, 'nw', { x: 5, y: 10 })).toEqual({ x: 5, y: 10, width: 55, height: 40 });
    expect(resizeRectangle({ x: 20, y: 20, width: 40, height: 30 }, 'se', { x: 20, y: 20 })).toEqual({ x: 20, y: 20, width: 1.5, height: 1.5 });
  });

  it('moves point collections without leaving the image', () => {
    expect(movePoints([{ x: 5, y: 10 }, { x: 95, y: 90 }], { x: 20, y: -20 })).toEqual([{ x: 10, y: 0 }, { x: 100, y: 80 }]);
  });

  it('creates and moves ellipses within bounds', () => {
    const ellipse = ellipseFromPoints({ x: 10, y: 20 }, { x: 50, y: 60 });
    expect(ellipse).toEqual({ cx: 30, cy: 40, rx: 20, ry: 20, rotation: 0 });
    expect(moveEllipse(ellipse, { x: -50, y: 80 })).toMatchObject({ cx: 20, cy: 80 });
  });
});
