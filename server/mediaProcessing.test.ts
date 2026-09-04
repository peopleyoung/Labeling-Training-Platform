import { describe, expect, it } from 'vitest';
import { buildSegments, safeArchiveRelativePath } from './mediaProcessing';

describe('media processing helpers', () => {
  it('rejects unsafe archive paths', () => {
    expect(safeArchiveRelativePath('images/a.jpg')).toBe('images/a.jpg');
    expect(safeArchiveRelativePath('../secrets.txt')).toBeNull();
    expect(safeArchiveRelativePath('/etc/passwd')).toBeNull();
    expect(safeArchiveRelativePath('C:\\windows\\system32')).toBeNull();
    expect(safeArchiveRelativePath('nested/../../escape.jpg')).toBeNull();
  });

  it('pools image resources by frame count while keeping videos isolated', () => {
    const segments = buildSegments([
      { id: 'a-1', sourceAssetId: 'asset-a', order: 1 },
      { id: 'c-1', sourceAssetId: 'asset-c', order: 2 },
      { id: 'd-1', sourceAssetId: 'asset-d', order: 3 },
      { id: 'b-1', sourceAssetId: 'asset-b', order: 1 },
      { id: 'b-2', sourceAssetId: 'asset-b', order: 2 },
    ], { imageSegmentSize: 2, videoSegmentSize: 2, sourceTypes: { 'asset-a': 'image', 'asset-b': 'video', 'asset-c': 'image', 'asset-d': 'archive' } });

    expect(segments).toEqual([
      { startItemId: 'a-1', endItemId: 'c-1', itemCount: 2, sequence: 1 },
      { startItemId: 'd-1', endItemId: 'd-1', itemCount: 1, sequence: 2 },
      { sourceAssetId: 'asset-b', startItemId: 'b-1', endItemId: 'b-2', itemCount: 2, sequence: 3 },
    ]);
  });

  it('uses overlap frames when splitting a source into ordered segments', () => {
    const segments = buildSegments(
      Array.from({ length: 5 }, (_, index) => ({ id: `frame-${index + 1}`, sourceAssetId: 'video-1', order: index + 1 })),
      { imageSegmentSize: 3, videoSegmentSize: 3, overlapSize: 1, sourceTypes: { 'video-1': 'video' } },
    );

    expect(segments).toEqual([
      { sourceAssetId: 'video-1', startItemId: 'frame-1', endItemId: 'frame-3', itemCount: 3, sequence: 1 },
      { sourceAssetId: 'video-1', startItemId: 'frame-3', endItemId: 'frame-5', itemCount: 3, sequence: 2 },
    ]);
  });
});
