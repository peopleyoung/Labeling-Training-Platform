import { describe, expect, it } from 'vitest';
import type { AnnotationRecord } from '../shared/contracts';
import { attributeAnnotations, diffAnnotations, summarizeAnnotationChanges } from './annotationAttribution';

const rectangle = (id: string, x = 10): AnnotationRecord => ({ id, label: 'defect', color: '#2383f2', geometry: { type: 'rectangle', x, y: 10, width: 20, height: 20 } });

describe('annotation attribution', () => {
  it('keeps the annotator creator when a reviewer changes the final geometry', () => {
    const original = attributeAnnotations([], [rectangle('box-1')], { id: 'annotator-1', role: 'annotator' }, '2026-09-02T00:00:00.000Z');
    const reviewed = attributeAnnotations(original, [rectangle('box-1', 15)], { id: 'reviewer-1', role: 'reviewer' }, '2026-09-02T00:01:00.000Z');

    expect(reviewed[0]).toMatchObject({ createdBy: 'annotator-1', createdByRole: 'annotator', updatedBy: 'reviewer-1', updatedByRole: 'reviewer' });
    expect(diffAnnotations(original, reviewed)).toEqual([{ objectId: 'box-1', changeType: 'updated', changedFields: ['geometry'], before: { geometry: original[0].geometry }, after: { geometry: reviewed[0].geometry } }]);
  });

  it('summarizes final-result object changes without metadata-only updates', () => {
    const changes = diffAnnotations([rectangle('deleted'), rectangle('updated')], [rectangle('created'), rectangle('updated', 20)]);
    expect(summarizeAnnotationChanges(changes)).toEqual({ added: 1, modified: 1, deleted: 1 });
  });
});
