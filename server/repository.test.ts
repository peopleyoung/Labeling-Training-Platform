import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { PgRepository } from './repository';

describe('PgRepository annotation revisions', () => {
  it('locks the stored revision and writes the next revision in one transaction', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rowCount: null, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'image-1' }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ revision: 1, review_status: 'draft' }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{
        dataset_id: 'dataset-1',
        image_id: 'image-1',
        revision: 2,
        annotations: [],
        updated_at: new Date('2026-07-27T00:00:00.000Z'),
        updated_by: 'user-1',
        review_status: 'draft',
      }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ total: '1', annotated: '0', approved: '0', submitted: '0' }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rowCount: null, rows: [] });
    const client = { query, release: vi.fn() };
    const repository = new PgRepository({ connect: vi.fn().mockResolvedValue(client) } as unknown as Pool);

    const document = await repository.saveAnnotations({ datasetId: 'dataset-1', imageId: 'image-1', revision: 1, annotations: [], updatedBy: 'user-1' });

    const [lockStatement, lockValues] = query.mock.calls[2] as [string, unknown[]];
    expect(lockStatement).toContain('FOR UPDATE');
    expect(lockValues).toEqual(['dataset-1', 'image-1']);
    const [statement, values] = query.mock.calls[3] as [string, unknown[]];
    expect(statement).toContain("review_status = 'draft'");
    expect(values[2]).toBe(2);
    expect(document.revision).toBe(2);
    expect(client.release).toHaveBeenCalledOnce();
  });
});
