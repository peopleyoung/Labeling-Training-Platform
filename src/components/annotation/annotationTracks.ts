import type { AnnotationGeometry, AnnotationRecord } from '../../../shared/contracts';

export interface TrackFrame {
  imageId: string;
  frameIndex: number;
  annotations: AnnotationRecord[];
}

export interface TrackPropagationResult {
  frames: TrackFrame[];
  incompatibleFrames: number[];
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function interpolateNumber(from: number, to: number, ratio: number) {
  return from + (to - from) * ratio;
}

function interpolatePoint(from: { x: number; y: number }, to: { x: number; y: number }, ratio: number) {
  return { x: interpolateNumber(from.x, to.x, ratio), y: interpolateNumber(from.y, to.y, ratio) };
}

function pointList(geometry: AnnotationGeometry) {
  return 'points' in geometry ? geometry.points : undefined;
}

export function interpolateGeometry(from: AnnotationGeometry, to: AnnotationGeometry, ratio: number): AnnotationGeometry | null {
  if (from.type !== to.type) return null;
  const progress = Math.max(0, Math.min(1, ratio));
  if (from.type === 'rectangle' && to.type === 'rectangle') {
    return {
      type: 'rectangle',
      x: interpolateNumber(from.x, to.x, progress),
      y: interpolateNumber(from.y, to.y, progress),
      width: interpolateNumber(from.width, to.width, progress),
      height: interpolateNumber(from.height, to.height, progress),
    };
  }
  if (from.type === 'ellipse' && to.type === 'ellipse') {
    return {
      type: 'ellipse',
      cx: interpolateNumber(from.cx, to.cx, progress),
      cy: interpolateNumber(from.cy, to.cy, progress),
      rx: interpolateNumber(from.rx, to.rx, progress),
      ry: interpolateNumber(from.ry, to.ry, progress),
      rotation: interpolateNumber(from.rotation, to.rotation, progress),
    };
  }
  if (from.type === 'keypoint' && to.type === 'keypoint') {
    return { ...from, ...interpolatePoint(from, to, progress) };
  }
  const fromPoints = pointList(from);
  const toPoints = pointList(to);
  if (!fromPoints || !toPoints || fromPoints.length !== toPoints.length) return null;
  if (from.type === 'polyline' && to.type === 'polyline') {
    return {
      ...from,
      strokeWidth: interpolateNumber(from.strokeWidth, to.strokeWidth, progress),
      points: fromPoints.map((point, index) => interpolatePoint(point, toPoints[index], progress)),
    };
  }
  if (from.type === 'skeleton' && to.type === 'skeleton') {
    if (from.edges.length !== to.edges.length || from.edges.some((edge, index) => edge[0] !== to.edges[index][0] || edge[1] !== to.edges[index][1])) return null;
    return {
      ...from,
      points: from.points.map((point, index) => ({ ...point, ...interpolatePoint(point, to.points[index], progress) })),
    };
  }
  if ((from.type === 'polygon' && to.type === 'polygon') || (from.type === 'cuboid' && to.type === 'cuboid')) {
    return { ...from, points: fromPoints.map((point, index) => interpolatePoint(point, toPoints[index], progress)) };
  }
  return null;
}

export function trackFrameId(trackId: string, imageId: string) {
  return `${trackId}:${imageId}`;
}

function isKeyframe(record: AnnotationRecord) {
  return record.keyframe !== false;
}

function makeInterpolatedRecord(anchor: AnnotationRecord, imageId: string, geometry: AnnotationGeometry): AnnotationRecord {
  return {
    ...clone(anchor),
    id: trackFrameId(anchor.trackId ?? '', imageId),
    geometry,
    keyframe: false,
    provenance: 'interpolated',
  };
}

export function propagateTrack(inputFrames: TrackFrame[], trackId: string): TrackPropagationResult {
  const frames = inputFrames.map((frame) => ({ ...frame, annotations: clone(frame.annotations) })).sort((left, right) => left.frameIndex - right.frameIndex);
  const occurrences = frames.flatMap((frame) => frame.annotations.filter((record) => record.trackId === trackId).map((record) => ({ frame, record })));
  if (!occurrences.length) return { frames, incompatibleFrames: [] };
  const keyframes = occurrences.filter(({ record }) => isKeyframe(record)).sort((left, right) => left.frame.frameIndex - right.frame.frameIndex);
  if (!keyframes.length) return { frames, incompatibleFrames: [] };
  const firstFrame = keyframes[0].frame.frameIndex;
  const incompatibleFrames: number[] = [];

  for (const frame of frames) {
    if (frame.frameIndex < firstFrame) continue;
    const current = frame.annotations.filter((record) => record.trackId === trackId);
    const keyframe = current.find(isKeyframe);
    if (keyframe) continue;

    const previous = [...keyframes].reverse().find(({ frame: keyframeFrame }) => keyframeFrame.frameIndex < frame.frameIndex);
    const next = keyframes.find(({ frame: keyframeFrame }) => keyframeFrame.frameIndex > frame.frameIndex);
    const anchor = previous ?? next;
    if (!anchor) continue;
    let geometry = anchor.record.geometry;
    if (previous && next) {
      const span = next.frame.frameIndex - previous.frame.frameIndex;
      const interpolated = interpolateGeometry(previous.record.geometry, next.record.geometry, span > 0 ? (frame.frameIndex - previous.frame.frameIndex) / span : 0);
      if (!interpolated) {
        incompatibleFrames.push(frame.frameIndex);
        continue;
      }
      geometry = interpolated;
    }
    const generated = makeInterpolatedRecord(anchor.record, frame.imageId, geometry);
    frame.annotations = [...frame.annotations.filter((record) => record.trackId !== trackId), generated];
  }

  return { frames, incompatibleFrames: [...new Set(incompatibleFrames)] };
}

export function nextTrackKeyframe(frames: TrackFrame[], currentIndex: number, trackId: string, direction: 1 | -1) {
  const candidates = frames.filter((frame) => frame.annotations.some((record) => record.trackId === trackId && isKeyframe(record))).map((frame) => frame.frameIndex).sort((left, right) => left - right);
  const ordered = direction > 0 ? candidates : [...candidates].reverse();
  return ordered.find((frameIndex) => direction > 0 ? frameIndex > currentIndex : frameIndex < currentIndex) ?? (direction > 0 ? candidates.at(-1) : candidates[0]);
}
