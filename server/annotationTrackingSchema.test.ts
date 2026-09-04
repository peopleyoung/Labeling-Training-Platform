import { describe, expect, it } from 'vitest';
import { annotationSaveSchema } from '../shared/schemas';

describe('annotation tracking schema', () => {
  it('retains annotation attributes, tracking metadata, and issue state', () => {
    const parsed = annotationSaveSchema.parse({
      revision: 0,
      annotations: [{
        id: 'box-1',
        label: 'defect',
        color: '#1890ff',
        geometry: { type: 'rectangle', x: 10, y: 10, width: 20, height: 20 },
        attributes: { severity: 2 },
        trackId: 'track-1',
        keyframe: true,
        provenance: 'manual',
        flagged: true,
      }],
    });

    expect(parsed.annotations[0]).toMatchObject({ attributes: { severity: 2 }, trackId: 'track-1', keyframe: true, provenance: 'manual', flagged: true });
  });
});
