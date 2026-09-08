import { describe, expect, it } from 'vitest';
import { MemoryRepository } from './repository';

describe('annotation jobs', () => {
  it('limits annotation and review claims to dataset members', async () => {
    const repository = new MemoryRepository({ datasets: [] });
    const dataset = await repository.createDataset({ taskTypeId: await createTestTaskType(repository), name: 'Assigned Jobs', description: '', version: 'v1', classes: [], annotatorIds: ['annotator-1'], reviewerIds: ['reviewer-1'] });
    const task = await repository.getAnnotationTask(dataset.id);
    await repository.updateAnnotationTaskStatus(dataset.id, 'annotating');
    await repository.createAnnotationSegments([{ id: 'assigned-segment', datasetId: dataset.id, annotationTaskId: task!.id, sourceAssetId: 'asset-1', sequence: 1, startItemId: 'image-1', endItemId: 'image-1', itemCount: 1 }]);
    expect(await repository.claimNextAnnotationJob(dataset.id, 'annotator-2')).toBeNull();
    const claimed = await repository.claimNextAnnotationJob(dataset.id, 'annotator-1');
    expect(claimed?.assigneeId).toBe('annotator-1');
    await repository.updateAnnotationJob(claimed!.id, { status: 'submitted' });
    expect(await repository.claimNextAnnotationReviewJob(dataset.id, 'reviewer-2')).toBeNull();
    expect((await repository.claimNextAnnotationReviewJob(dataset.id, 'reviewer-1'))?.reviewerId).toBe('reviewer-1');
  });

  it('prefers rework and then claims the first available job', async () => {
    const repository = new MemoryRepository({ datasets: [] });
    const dataset = await repository.createDataset({ taskTypeId: await createTestTaskType(repository), name: 'Jobs', description: '', version: 'v1', classes: [] });
    const task = await repository.getAnnotationTask(dataset.id);
    await repository.updateAnnotationTaskStatus(dataset.id, 'annotating');
    const segments = await repository.createAnnotationSegments([
      { id: 'segment-1', datasetId: dataset.id, annotationTaskId: task!.id, sourceAssetId: 'asset-1', sequence: 1, startItemId: 'image-1', endItemId: 'image-1', itemCount: 1 },
      { id: 'segment-2', datasetId: dataset.id, annotationTaskId: task!.id, sourceAssetId: 'asset-1', sequence: 2, startItemId: 'image-2', endItemId: 'image-2', itemCount: 1 },
    ]);
    const jobs = await repository.listAnnotationJobs(dataset.id);
    expect(jobs).toHaveLength(2);
    await repository.updateAnnotationJob(jobs[1].id, { status: 'rework', assigneeId: 'annotator-1' });
    const claimed = await repository.claimNextAnnotationJob(dataset.id, 'annotator-1');
    expect(claimed).toMatchObject({ id: jobs[1].id, status: 'claimed', assigneeId: 'annotator-1' });
    const next = await repository.claimNextAnnotationJob(dataset.id, 'annotator-2');
    expect(next).toMatchObject({ id: jobs[0].id, status: 'claimed', assigneeId: 'annotator-2' });
    expect(await repository.claimNextAnnotationJob(dataset.id, 'annotator-3')).toBeNull();
  });

  it('locks submitted work to one reviewer and returns rejected work to its annotator', async () => {
    const repository = new MemoryRepository({ datasets: [] });
    const dataset = await repository.createDataset({ taskTypeId: await createTestTaskType(repository), name: 'Review Jobs', description: '', version: 'v1', classes: [] });
    const task = await repository.getAnnotationTask(dataset.id);
    await repository.createAnnotationSegments([{ id: 'review-segment', datasetId: dataset.id, annotationTaskId: task!.id, sourceAssetId: 'asset-1', sequence: 1, startItemId: 'image-1', endItemId: 'image-1', itemCount: 1 }]);
    const [job] = await repository.listAnnotationJobs(dataset.id);
    await repository.updateAnnotationJob(job.id, { status: 'submitted', assigneeId: 'annotator-1' });

    const claimed = await repository.claimNextAnnotationReviewJob(dataset.id, 'reviewer-1');
    expect(claimed).toMatchObject({ id: job.id, status: 'reviewing', reviewerId: 'reviewer-1', assigneeId: 'annotator-1' });
    expect(await repository.claimNextAnnotationReviewJob(dataset.id, 'reviewer-2')).toBeNull();
    expect(await repository.reviewAnnotationJob(job.id, 'reviewer-2', 'approve')).toBeNull();

    const original = await repository.saveAnnotations({ datasetId: dataset.id, imageId: 'image-1', revision: 0, annotations: [], updatedBy: 'annotator-1' });
    const edited = await repository.saveAnnotations({ datasetId: dataset.id, imageId: 'image-1', revision: original.revision, annotations: [{ id: 'box-1', label: 'defect', color: '#2383f2', geometry: { type: 'rectangle', x: 10, y: 10, width: 20, height: 20 } }], updatedBy: 'reviewer-1', reviewJobId: job.id, reviewerId: 'reviewer-1' });
    expect(edited).toMatchObject({ revision: original.revision + 1, reviewStatus: 'draft', updatedBy: 'reviewer-1', annotations: [{ createdBy: 'reviewer-1', createdByRole: 'reviewer' }] });

    const rejected = await repository.reviewAnnotationJob(job.id, 'reviewer-1', 'reject', '请补全目标边界');
    expect(rejected).toMatchObject({ status: 'rework', assigneeId: 'annotator-1', reviewComment: '请补全目标边界' });
  });

  it('allows administrators to review assigned datasets', async () => {
    const repository = new MemoryRepository({ datasets: [] });
    const dataset = await repository.createDataset({ taskTypeId: await createTestTaskType(repository), name: 'Admin Review Jobs', description: '', version: 'v1', classes: [], reviewerIds: ['reviewer-1'] });
    const task = await repository.getAnnotationTask(dataset.id);
    await repository.createAnnotationSegments([{ id: 'admin-review-segment', datasetId: dataset.id, annotationTaskId: task!.id, sourceAssetId: 'asset-1', sequence: 1, startItemId: 'image-1', endItemId: 'image-1', itemCount: 1 }]);
    const [job] = await repository.listAnnotationJobs(dataset.id);
    await repository.updateAnnotationJob(job.id, { status: 'submitted', assigneeId: 'annotator-1' });

    expect(await repository.claimNextAnnotationReviewJob(dataset.id, 'admin-1')).toBeNull();
    expect(await repository.claimNextAnnotationReviewJob(dataset.id, 'admin-1', true)).toMatchObject({ id: job.id, status: 'reviewing', reviewerId: 'admin-1' });
  });

  it('synchronizes document review state across submit, approve, and reopen', async () => {
    const repository = new MemoryRepository({ datasets: [] });
    const dataset = await repository.createDataset({ taskTypeId: await createTestTaskType(repository), name: 'Lifecycle Jobs', description: '', version: 'v1', classes: [] });
    const image = await repository.createDatasetImage({ datasetId: dataset.id, filename: 'frame.png', mimeType: 'image/png', sizeBytes: 1, objectKey: 'frame.png', split: 'train' });
    const task = await repository.getAnnotationTask(dataset.id);
    await repository.updateAnnotationTaskStatus(dataset.id, 'annotating');
    await repository.createAnnotationSegments([{ id: 'lifecycle-segment', datasetId: dataset.id, annotationTaskId: task!.id, sourceAssetId: 'asset-1', sequence: 1, startItemId: image.id, endItemId: image.id, itemCount: 1 }]);
    const [job] = await repository.listAnnotationJobs(dataset.id);
    await repository.saveAnnotations({ datasetId: dataset.id, imageId: image.id, revision: 0, annotations: [{ id: 'box', label: 'defect', color: '#000', geometry: { type: 'rectangle', x: 1, y: 1, width: 2, height: 2 } }], updatedBy: 'annotator-1' });
    await repository.claimNextAnnotationJob(dataset.id, 'annotator-1');
    await repository.submitAnnotationJob(job.id, 'annotator-1');
    expect((await repository.getAnnotations(dataset.id, image.id))?.reviewStatus).toBe('submitted');
    await repository.claimNextAnnotationReviewJob(dataset.id, 'reviewer-1');
    await repository.reviewAnnotationJob(job.id, 'reviewer-1', 'approve');
    expect((await repository.getAnnotations(dataset.id, image.id))?.reviewStatus).toBe('approved');
    expect((await repository.getDataset(dataset.id))?.status).toBe('可训练');
    await repository.reopenAnnotationJob(job.id, 'admin-1', '补充质量检查');
    expect((await repository.getAnnotations(dataset.id, image.id))?.reviewStatus).toBe('rejected');
    expect((await repository.getAnnotationJob(job.id))?.status).toBe('rework');
    expect((await repository.getDataset(dataset.id))?.status).toBe('标注中');
  });

  it('synchronizes job status when dataset-level image review is approved', async () => {
    const repository = new MemoryRepository({ datasets: [] });
    const dataset = await repository.createDataset({ taskTypeId: await createTestTaskType(repository), name: 'Dataset Review Sync', description: '', version: 'v1', classes: ['defect'] });
    const image = await repository.createDatasetImage({ datasetId: dataset.id, filename: 'frame.png', mimeType: 'image/png', sizeBytes: 1, objectKey: 'frame.png', split: 'train' });
    const task = await repository.getAnnotationTask(dataset.id);
    await repository.createAnnotationSegments([{ id: 'dataset-review-segment', datasetId: dataset.id, annotationTaskId: task!.id, sourceAssetId: 'asset-1', sequence: 1, startItemId: image.id, endItemId: image.id, itemCount: 1 }]);
    const [job] = await repository.listAnnotationJobs(dataset.id);
    await repository.saveAnnotations({ datasetId: dataset.id, imageId: image.id, revision: 0, annotations: [{ id: 'box', label: 'defect', color: '#000', geometry: { type: 'rectangle', x: 1, y: 1, width: 2, height: 2 } }], updatedBy: 'annotator-1' });
    await repository.submitAnnotationReview(dataset.id, 'annotator-1');

    expect((await repository.getAnnotationJob(job.id))?.status).toBe('submitted');
    await repository.decideAnnotationReview(dataset.id, { imageIds: [image.id], decision: 'approve', reviewedBy: 'reviewer-1' });
    expect((await repository.getAnnotationJob(job.id))?.status).toBe('approved');
  });
});
import { createTestTaskType } from './testCatalogFixtures';
