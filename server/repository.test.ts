import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRepository, PgRepository } from './repository';

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
    expect(statement).toContain('review_status = EXCLUDED.review_status');
    expect(values[2]).toBe(2);
    expect(document.revision).toBe(2);
    expect(client.release).toHaveBeenCalledOnce();
  });
});

describe('PgRepository dataset review state', () => {
  it('repairs a stale dataset status before returning it', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ total: '1', annotated: '1', approved: '1', submitted: '0' }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'dataset-1', name: 'Dataset', description: '', version: 'v1', images: 1, annotated: 1, classes: [], size: '1 KB', status: '可训练', updated_at: new Date('2026-07-27T00:00:00.000Z'), annotator_ids: [], reviewer_ids: [], processing_config: {}, label_schema: [] }] });
    const repository = new PgRepository({ query } as unknown as Pool);

    await expect(repository.getDataset('dataset-1')).resolves.toMatchObject({ id: 'dataset-1', status: '可训练' });
    expect(query.mock.calls[1][0]).toContain('IS DISTINCT FROM');
  });
});

describe('PgRepository annotation job submission', () => {
  it('allows the assigned annotator to resubmit a rework Job', async () => {
    const job = {
      id: 'job-rework',
      dataset_id: 'dataset-1',
      annotation_task_id: 'task-1',
      segment_id: 'segment-1',
      sequence: 1,
      status: 'submitted',
      assignee_id: 'annotator-1',
      created_at: new Date('2026-07-27T00:00:00.000Z'),
    };
    const query = vi.fn()
      .mockResolvedValueOnce({ rowCount: null, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ ...job, status: 'rework' }] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [job] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ total: '1', annotated: '1', approved: '0', submitted: '1' }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rowCount: null, rows: [] });
    const client = { query, release: vi.fn() };
    const repository = new PgRepository({ connect: vi.fn().mockResolvedValue(client) } as unknown as Pool);

    const submitted = await repository.submitAnnotationJob('job-rework', 'annotator-1');

    expect(submitted).toMatchObject({ id: 'job-rework', status: 'submitted', assigneeId: 'annotator-1' });
    expect((query.mock.calls[1] as [string, unknown[]])[0]).toContain("status IN ('claimed','in_progress','rework')");
    expect(client.release).toHaveBeenCalledOnce();
  });
});

describe('PgRepository annotation statistics', () => {
  it('scopes annotation jobs and review audit rows through datasets', async () => {
    const query = vi.fn((statement: string) => {
      if (statement.includes('annotation_documents')) {
        return Promise.resolve({ rows: [{ annotations: [{ id: 'object-1', createdBy: 'annotator-1', createdByRole: 'annotator' }], review_status: 'approved' }] });
      }
      if (statement.includes('annotation_jobs')) {
        expect(statement).toContain('JOIN datasets');
        return Promise.resolve({ rows: [{ status: 'approved', assignee_id: 'annotator-1' }, { status: 'rework', assignee_id: 'annotator-1' }] });
      }
      if (statement.includes('audit_logs')) {
        expect(statement).toContain('JOIN datasets');
        return Promise.resolve({ rows: [{ actor_id: 'reviewer-1', metadata: { counts: { added: 1, modified: 2, deleted: 1 } } }] });
      }
      throw new Error(`Unexpected SQL: ${statement}`);
    });
    const repository = new PgRepository({ query } as unknown as Pool);

    await expect(repository.getAnnotationStatistics(undefined, { id: 'admin-1', role: 'admin' })).resolves.toMatchObject({
      annotatorCreatedObjects: 1,
      finalEffectiveObjects: 1,
      completedFrames: 1,
      completedJobs: 1,
      reviewerAddedObjects: 1,
      reviewerModifiedObjects: 2,
      reviewerDeletedObjects: 1,
      approvedJobs: 1,
      rejectedJobs: 1,
    });
  });
});

describe('MemoryRepository training snapshots', () => {
  it('includes approved jobs whose frames have empty annotations', async () => {
    const repository = new MemoryRepository();
    const dataset = await repository.createDataset({ name: 'Empty frame dataset', description: '', version: 'v1', classes: ['background'] });
    const image = await repository.createDatasetImage({ datasetId: dataset.id, filename: 'empty.png', mimeType: 'image/png', sizeBytes: 1, objectKey: `datasets/${dataset.id}/empty.png`, split: 'train' });
    const task = await repository.getAnnotationTask(dataset.id);
    await repository.createAnnotationSegments([{ id: 'segment-empty-frame', datasetId: dataset.id, annotationTaskId: task!.id, sequence: 1, startItemId: image.id, endItemId: image.id, itemCount: 1 }]);
    await repository.updateAnnotationTaskStatus(dataset.id, 'annotating');
    const claimed = await repository.claimNextAnnotationJob(dataset.id, 'annotator-1');
    expect(claimed).toBeTruthy();
    await repository.submitAnnotationJob(claimed!.id, 'annotator-1');
    const reviewJob = await repository.claimNextAnnotationReviewJob(dataset.id, 'reviewer-1');
    expect(reviewJob).toBeTruthy();
    await repository.reviewAnnotationJob(reviewJob!.id, 'reviewer-1', 'approve');

    const snapshot = await repository.createTrainingSnapshot({ datasetId: dataset.id, createdBy: 'reviewer-1' });
    expect(snapshot.images).toHaveLength(1);
    expect(snapshot.documents).toHaveLength(1);
    expect(snapshot.documents[0]).toMatchObject({ imageId: image.id, annotations: [], reviewStatus: 'approved' });
  });
});

describe('MemoryRepository annotation progress', () => {
  it('counts empty frames as annotated after a job is submitted', async () => {
    const repository = new MemoryRepository();
    const dataset = await repository.createDataset({ name: 'Submitted empty frames', description: '', version: 'v1', classes: [] });
    const first = await repository.createDatasetImage({ datasetId: dataset.id, filename: 'first.png', mimeType: 'image/png', sizeBytes: 1, objectKey: `datasets/${dataset.id}/first.png`, split: 'train' });
    const second = await repository.createDatasetImage({ datasetId: dataset.id, filename: 'second.png', mimeType: 'image/png', sizeBytes: 1, objectKey: `datasets/${dataset.id}/second.png`, split: 'train' });
    const task = await repository.getAnnotationTask(dataset.id);
    await repository.createAnnotationSegments([{ id: 'segment-empty-submit', datasetId: dataset.id, annotationTaskId: task!.id, sequence: 1, startItemId: first.id, endItemId: second.id, itemCount: 2 }]);
    await repository.updateAnnotationTaskStatus(dataset.id, 'annotating');
    const job = await repository.claimNextAnnotationJob(dataset.id, 'annotator-1');

    await repository.submitAnnotationJob(job!.id, 'annotator-1');

    await expect(repository.getDataset(dataset.id)).resolves.toMatchObject({ images: 2, annotated: 2, status: '待审核' });
  });
});
