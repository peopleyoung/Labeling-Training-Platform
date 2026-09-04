import { describe, expect, it } from 'vitest';
import type { AnnotationRecord } from '../../../shared/contracts';
import { interpolateGeometry, nextTrackKeyframe, propagateTrack } from './annotationTracks';

function rectangle(id: string, x: number, options: Partial<AnnotationRecord> = {}): AnnotationRecord {
  return { id, label: 'defect', color: '#1890ff', geometry: { type: 'rectangle', x, y: 10, width: 20, height: 20 }, ...options };
}

describe('annotation tracks', () => {
  it('interpolates compatible geometries', () => {
    expect(interpolateGeometry(rectangle('a', 0).geometry, rectangle('b', 40).geometry, 0.5)).toMatchObject({ x: 20, y: 10, width: 20, height: 20 });
  });

  it('interpolates all eight cuboid vertices', () => {
    const from = { type: 'cuboid' as const, points: Array.from({ length: 8 }, (_, index) => ({ x: index, y: index })) };
    const to = { type: 'cuboid' as const, points: Array.from({ length: 8 }, (_, index) => ({ x: index + 8, y: index + 8 })) };
    expect(interpolateGeometry(from, to, 0.5)).toMatchObject({ type: 'cuboid', points: [{ x: 4, y: 4 }, { x: 5, y: 5 }, { x: 6, y: 6 }, { x: 7, y: 7 }, { x: 8, y: 8 }, { x: 9, y: 9 }, { x: 10, y: 10 }, { x: 11, y: 11 }] });
  });

  it('propagates a track while preserving unrelated objects', () => {
    const result = propagateTrack([
      { imageId: 'image-1', frameIndex: 0, annotations: [rectangle('track-1', 0, { trackId: 'track-1', keyframe: true, provenance: 'manual' })] },
      { imageId: 'image-2', frameIndex: 1, annotations: [rectangle('unrelated', 70)] },
      { imageId: 'image-3', frameIndex: 2, annotations: [rectangle('track-3', 40, { trackId: 'track-1', keyframe: true, provenance: 'manual' })] },
    ], 'track-1');
    expect(result.incompatibleFrames).toEqual([]);
    expect(result.frames[1].annotations).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'track-1:image-2', provenance: 'interpolated', geometry: expect.objectContaining({ x: 20 }) }), expect.objectContaining({ id: 'unrelated' })]));
  });

  it('does not interpolate incompatible point topologies', () => {
    const result = propagateTrack([
      { imageId: 'image-1', frameIndex: 0, annotations: [{ ...rectangle('a', 0, { trackId: 'track-1', keyframe: true }), geometry: { type: 'polygon', points: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 10, y: 20 }] } }] },
      { imageId: 'image-2', frameIndex: 1, annotations: [] },
      { imageId: 'image-3', frameIndex: 2, annotations: [{ ...rectangle('b', 40, { trackId: 'track-1', keyframe: true }), geometry: { type: 'polygon', points: [{ x: 40, y: 0 }, { x: 60, y: 0 }] } }] },
    ], 'track-1');
    expect(result.incompatibleFrames).toEqual([1]);
    expect(result.frames[1].annotations).toEqual([]);
  });

  it('finds the next and previous keyframes', () => {
    const frames = [0, 2, 4].map((frameIndex) => ({ imageId: `image-${frameIndex}`, frameIndex, annotations: [rectangle(`track-${frameIndex}`, frameIndex, { trackId: 'track-1', keyframe: true })] }));
    expect(nextTrackKeyframe(frames, 1, 'track-1', 1)).toBe(2);
    expect(nextTrackKeyframe(frames, 3, 'track-1', -1)).toBe(2);
  });
});
