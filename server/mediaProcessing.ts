import { isAbsolute, normalize, sep } from 'node:path';

export interface SegmentableMediaItem { id: string; sourceAssetId: string; order: number; }
export interface SegmentDraft { sourceAssetId?: string; startItemId: string; endItemId: string; itemCount: number; sequence: number; }

export function safeArchiveRelativePath(value: string) {
  const unixValue = value.replaceAll('\\', '/');
  if (!unixValue || unixValue.includes('\0') || unixValue.startsWith('/') || /^[a-zA-Z]:\//.test(unixValue)) return null;
  const normalized = normalize(unixValue).replaceAll(sep, '/');
  if (!normalized || normalized === '..' || normalized.startsWith('../') || isAbsolute(normalized)) return null;
  return normalized;
}

export function buildSegments(items: SegmentableMediaItem[], options: { imageSegmentSize: number; videoSegmentSize: number; overlapSize?: number; sourceTypes: Record<string, 'image' | 'archive' | 'video'> }): SegmentDraft[] {
  const segments: SegmentDraft[] = [];
  let sequence = 1;
  const overlap = Math.max(0, options.overlapSize ?? 0);
  const imageItems = items.filter((item) => options.sourceTypes[item.sourceAssetId] !== 'video').sort((left, right) => left.order - right.order);
  const imageStep = Math.max(1, options.imageSegmentSize - overlap);
  for (let offset = 0; offset < imageItems.length; offset += imageStep) {
    const chunk = imageItems.slice(offset, offset + options.imageSegmentSize);
    segments.push({ startItemId: chunk[0].id, endItemId: chunk.at(-1)!.id, itemCount: chunk.length, sequence });
    sequence += 1;
    if (offset + options.imageSegmentSize >= imageItems.length) break;
  }

  const videosBySource = new Map<string, SegmentableMediaItem[]>();
  for (const item of items) {
    if (options.sourceTypes[item.sourceAssetId] !== 'video') continue;
    videosBySource.set(item.sourceAssetId, [...(videosBySource.get(item.sourceAssetId) ?? []), item]);
  }
  for (const [sourceAssetId, sourceItems] of videosBySource) {
    sourceItems.sort((left, right) => left.order - right.order);
    const chunkSize = options.videoSegmentSize;
    const videoStep = Math.max(1, chunkSize - overlap);
    for (let offset = 0; offset < sourceItems.length; offset += videoStep) {
      const chunk = sourceItems.slice(offset, offset + chunkSize);
      segments.push({ sourceAssetId, startItemId: chunk[0].id, endItemId: chunk.at(-1)!.id, itemCount: chunk.length, sequence });
      sequence += 1;
      if (offset + chunkSize >= sourceItems.length) break;
    }
  }
  return segments;
}
