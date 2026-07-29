# Database Guidelines

## Overview

The backend uses plain `pg` queries behind `server/repository.ts`. SQL schema changes live in numbered files under `db/migrations/`; seed data lives in `server/seed.ts` and `server/seedDatabase.ts`.

PostgreSQL is the product source of truth for domain records. Redis/BullMQ schedules work, and files live under the worker artifact root or object-storage abstraction, but task state and artifact metadata must always be written back to PostgreSQL.

## Scenario: Workspace-Scoped Tasks And Artifact Lineage

### 1. Scope / Trigger

- Trigger: any API or worker code that creates training jobs, conversion jobs, export tasks, model versions, or artifacts.
- Reason: these tables have `workspace_id TEXT NOT NULL`; in-memory repository tests will not catch missing PostgreSQL columns.

### 2. Signatures

- `training_jobs(id, workspace_id, ..., created_by, config)`
- `conversion_jobs(id, workspace_id, ..., created_by)`
- `export_tasks(id, workspace_id, dataset_id, format, status, progress, artifact_id, created_by)`
- `model_versions(id, workspace_id, name, version, task, source_job, ..., formats, stage)`
- `artifacts(id, workspace_id, object_key, filename, mime_type, size_bytes, sha256, source_type, source_id, created_by)`

### 3. Contracts

- Every insert into a workspace-owned table must pass `workspace_id` explicitly. Do not rely on database defaults.
- Every worker-produced file that should be user-visible must create an `artifacts` row with:
  - `object_key`: stable storage key such as `training/<taskId>/<file>`, `conversions/<taskId>/<file>`, or `exports/<taskId>/<file>`.
  - `source_type`: `training_job`, `conversion_job`, or `export_task`.
  - `source_id`: the originating task id.
  - `sha256` and `size_bytes`: computed from the produced file before task completion.
- Successful training jobs must create or update traceable `model_versions` records using the training job id as source lineage.

### 4. Validation & Error Matrix

- Missing dataset/model/task row -> throw, then worker marks the originating task `failed`.
- Worker command exits non-zero -> task becomes `failed` with `error_message`.
- Worker produces no artifact file -> task becomes `failed`; do not mark complete.
- Export worker completes -> `export_tasks.status='completed'`, `progress=100`, and `artifact_id` points to `artifacts.id`.

### 5. Good/Base/Bad Cases

- Good: `PgRepository.createTrainingJob()` inserts `workspace_id`, stores raw config JSONB, asserts `RETURNING *`, then maps the returned row.
- Base: `MemoryRepository` may use seed arrays, but it must preserve the same DTO shape as PostgreSQL.
- Bad: inserting an export task without `workspace_id`, or marking a conversion complete with `size='待归档'` but no `artifacts` row.

### 6. Tests Required

- API tests must assert queueing and machine-readable errors.
- Worker smoke must validate every supported training and conversion profile without starting heavyweight training.
- Worker artifact tests must execute at least one local executor and assert files exist with non-zero size.
- Compose validation must parse the GPU worker service and its `/data` artifact volume.

### 7. Wrong vs Correct

#### Wrong

```ts
await pool.query(
  'INSERT INTO export_tasks(id, dataset_id, format, status, progress, created_by) VALUES ($1,$2,$3,$4,$5,$6)',
  [id, datasetId, format, 'queued', 0, createdBy],
);
```

#### Correct

```ts
await pool.query(
  'INSERT INTO export_tasks(id, workspace_id, dataset_id, format, status, progress, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)',
  [id, workspaceId, datasetId, format, 'queued', 0, createdBy],
);
```

## Query Patterns

- Keep SQL inside repository/worker modules; React code never knows database column names.
- Use `RETURNING *` for create/update methods and fail explicitly if no row is returned.
- Map snake_case rows to shared DTOs in one place (`mapJob`, `mapConversion`, etc.).
- Serialize JSONB inputs with `JSON.stringify()` at the boundary.

## Scenario: Terminal Training Job Deletion

### 1. Scope / Trigger

- Trigger: deleting a training task from the list or detail page.
- Reason: task state exists in PostgreSQL and BullMQ, while completed model artifacts have an independent lifecycle. Deleting only one side can start an orphan Worker or destroy a reusable model.

### 2. Signatures

- `DELETE /api/v1/training/jobs/:jobId -> 204 No Content`
- `TaskQueue.remove('training', jobId, 'cpu' | 'gpu') -> Promise<void>`
- `Repository.deleteTrainingJob(jobId) -> Promise<boolean>`
- `training_events`, `training_metrics`, and `training_resource_samples` reference `training_jobs(id) ON DELETE CASCADE`.

### 3. Contracts

- Only `admin` and `engineer` roles may delete training jobs.
- Only `completed`, `failed`, or `cancelled` jobs are deletable. A queued or running job must be stopped first.
- Cancellation is a cross-layer protocol, not a PostgreSQL status update alone:
  - The API changes the source-of-truth row to `cancelled` and immediately removes a queued BullMQ job.
  - An active Worker polls the persisted status, aborts the runner, and terminates the complete OS process group so framework subprocesses cannot survive their Python parent.
  - The Worker returns from the BullMQ handler only after pending telemetry writes and temporary-file cleanup finish, releasing the active lock.
- Remove the retained BullMQ job from the queue matching the persisted execution target before deleting the PostgreSQL row.
- Deletion of a cancelled job waits for a bounded Worker shutdown window before returning `TRAINING_DELETE_PENDING`; users should not need to manually retry during normal process teardown.
- Worker failure updates must use `WHERE status IN ('queued', 'running')`. A late process exit must never overwrite `cancelled` with `failed` or append a misleading error event.
- Deleting the task cascades its events, metrics, and resource samples.
- Preserve `model_versions`, `artifacts`, and artifact bytes. Their lineage retains the historical source job id even after the operational task row is removed.
- Write a `training.delete` audit record with the deleted id, name, terminal status, and whether an artifact was preserved.

### 4. Validation & Error Matrix

- Unknown job -> `404 TRAINING_JOB_NOT_FOUND`.
- Queued or running job -> `409 TRAINING_DELETE_NOT_ALLOWED`.
- Cancelled row whose BullMQ job leaves `active` within the shutdown window -> remove the queue record and return `204` in the same request.
- Cancelled row whose BullMQ job remains active beyond the bounded shutdown window -> `409 TRAINING_DELETE_PENDING`.
- Annotator request -> `403 FORBIDDEN`.
- Redis/storage failure other than an active job -> propagate as an operational failure; do not delete the PostgreSQL row.

### 5. Good/Base/Bad Cases

- Good: failed CPU job -> remove `training-<id>` from `forge-cpu`, delete the job row, cascade telemetry, preserve its registered model/artifact, then return 204.
- Base: completed job has already aged out of BullMQ -> queue removal is a no-op and PostgreSQL deletion succeeds.
- Bad: delete a running row and let the Worker later write events to a missing foreign key, or cascade-delete the trained model when the user only selected task history.

### 6. Tests Required

- API integration tests assert role protection, active-state conflict, terminal deletion, repeat-delete 404, and queue cleanup.
- Cancellation regression coverage must include both queued removal and `running -> cancelled -> immediate DELETE`, proving the delete path waits for Worker lock release.
- Deployment smoke coverage must confirm the Python runner and its framework subprocess are both gone after cancellation; database-only assertions are insufficient.
- Repository/memory tests assert events and observability records disappear with the job.
- Queue unit tests assert removal is scoped by kind, id, and execution target.
- Component tests assert terminal rows expose a confirmation dialog and running rows do not expose deletion.

### 7. Wrong vs Correct

#### Wrong

```ts
await repository.deleteTrainingJob(jobId);
// The queued BullMQ job can still be picked up after the database row is gone.
```

#### Correct

```ts
if (job.status === 'queued' || job.status === 'running') {
  throw new HttpError(409, 'TRAINING_DELETE_NOT_ALLOWED', 'Stop the job first');
}
await queue.remove('training', job.id, job.gpu === 'CPU' ? 'cpu' : 'gpu');
await repository.deleteTrainingJob(job.id);
```

Worker failure handling must preserve the terminal cancellation decision:

```ts
await pool.query(
  "UPDATE training_jobs SET status = 'failed', error_message = $2 " +
  "WHERE id = $1 AND status IN ('queued', 'running')",
  [taskId, message],
);
```

## Scenario: Optimistic Annotation Revisions

### 1. Scope / Trigger

- Trigger: creating or changing annotation document persistence.
- Reason: the client revision is both the optimistic-lock token and the base used to calculate the next revision; those values are related but not interchangeable.

### 2. Signatures

- `putAnnotationDocument({ datasetId, imageId, revision, annotations, updatedBy })`
- `annotation_documents.revision INTEGER NOT NULL`

### 3. Contracts

- Insert a new document at revision `input.revision + 1`.
- On conflict, update only when the stored revision equals `input.revision`.
- Write the new revision as `input.revision + 1`; never compare the stored revision with that new value in the optimistic-lock condition.
- A zero-row `RETURNING *` result is an optimistic-lock conflict and becomes `409 ANNOTATION_REVISION_CONFLICT` at the API boundary.

### 4. Validation & Error Matrix

- Missing image or dataset -> the owning not-found error; do not create an orphan annotation document.
- Stored revision equals client revision -> persist annotations and return the incremented revision.
- Stored revision differs from client revision -> preserve the stored document and return a conflict.

### 5. Good/Base/Bad Cases

- Good: stored revision `1`, client revision `1` -> update content and return revision `2`.
- Base: no document, client revision `0` -> insert revision `1`.
- Bad: compare stored revision `1` with proposed revision `2`; every second save then conflicts.

### 6. Tests Required

- Repository regression test must inspect SQL parameters and prove the conflict predicate receives the client revision, while the written column receives the incremented revision.
- Integration coverage must execute `0 -> 1 -> 2`, then submit stale revision `1` and expect `409` without changing the stored revision `2` document.

### 7. Wrong vs Correct

#### Wrong

```sql
DO UPDATE SET revision = $3
WHERE annotation_documents.revision = $3
```

#### Correct

```sql
DO UPDATE SET revision = $3
WHERE annotation_documents.revision = $6
```

Here `$3` is `input.revision + 1`, while `$6` is `input.revision`.

## Scenario: Export Observation And Artifact Delivery

### 1. Scope / Trigger

- Trigger: adding export task status, artifact metadata, failure reporting, or a download endpoint.
- Reason: queuing an export is not sufficient for a product workflow. Clients must be able to read progress, distinguish a worker failure, inspect the generated artifact, and retrieve its bytes.

### 2. Signatures

- `GET /api/v1/datasets/:datasetId/exports -> { items: ExportTask[] }`
- `GET /api/v1/exports/:exportId -> ExportTask`
- `GET /api/v1/artifacts/:artifactId -> Artifact`
- `GET /api/v1/artifacts/:artifactId/download -> attachment stream`
- `export_tasks.error_message TEXT` is added through a new numbered migration, never by editing an applied migration.

### 3. Contracts

- `ExportTask` includes `status`, `progress`, optional `artifactId`, and optional `errorMessage`.
- `Artifact` includes its stable object key, filename, MIME type, byte size, SHA-256, source type/id, and creation time.
- The API resolves a local artifact as `resolve(FORGE_ARTIFACT_ROOT, artifact.objectKey)` and rejects a resolved path outside the root. Compose mounts the worker data volume read-only into the API container for this local-development delivery path.
- Object keys and physical storage paths remain backend concerns. The frontend receives metadata and an authenticated endpoint, never a database path.

### 4. Validation & Error Matrix

- Unknown dataset/export/artifact -> `404 DATASET_NOT_FOUND`, `EXPORT_NOT_FOUND`, or `ARTIFACT_NOT_FOUND`.
- Artifact object key escaping the configured root -> `400 INVALID_ARTIFACT_PATH`.
- Artifact row exists but the local file is unavailable -> `404 ARTIFACT_CONTENT_NOT_FOUND`.
- Worker export exception -> `export_tasks.status='failed'` and `error_message` is populated before the BullMQ job is rethrown.

### 5. Good/Base/Bad Cases

- Good: worker registers an artifact, updates `artifact_id`, then exposes it through the repository and authenticated API routes.
- Base: a queued export has no `artifactId` yet but is still observable through the list and detail routes.
- Bad: return a host file path to the browser, or mark an export failed without its machine-readable task state and user-facing failure reason.

### 6. Tests Required

- API test creates an export, asserts queue enrollment, then verifies both list and detail routes retain the same id/status/progress contract.
- Worker test forces an export failure and asserts persisted `status='failed'` plus `error_message`.
- Artifact download test covers metadata, attachment headers, missing content, and root traversal rejection using a temporary artifact root.

### 7. Wrong vs Correct

#### Wrong

```ts
await pool.query("UPDATE export_tasks SET status = 'failed' WHERE id = $1", [taskId]);
```

#### Correct

```ts
await pool.query(
  "UPDATE export_tasks SET status = 'failed', error_message = $2, updated_at = NOW() WHERE id = $1",
  [taskId, message],
);
```

## Scenario: Annotated-Only Dataset Exports

### 1. Scope / Trigger

- Trigger: generating a COCO, VOC, or segmentation export for any dataset scope.
- Reason: deployment-ready training packages must not contain images without annotations. The selected split limits the candidate set, and the annotation predicate limits the exported set within that scope.

### 2. Signatures

- `POST /api/v1/datasets/:datasetId/exports` keeps the existing `format`, `scope`, `versionName`, and `includeImages` request contract.
- Export worker image selection joins `dataset_images` to `annotation_documents` and requires `jsonb_typeof(annotations) = 'array' AND jsonb_array_length(annotations) > 0`.
- `manifest.json` records `annotatedOnly: true`, `imageCount`, and `excludedUnannotatedImageCount`.

### 3. Contracts

- An image is annotated only when its persisted annotation document contains at least one annotation object. A missing document or `annotations: []` is unannotated.
- Scope selection (`all`, `train`, `validation`, or `test`) and annotated-only selection are both mandatory for every supported export format.
- COCO image entries, VOC XML files, segmentation masks, and optional copied source images must all use the same selected image set.
- Filter in the worker SQL to avoid unnecessary object-storage reads, and filter defensively in the archive builder so direct callers cannot create an inconsistent package.

### 4. Validation & Error Matrix

- No annotated images in the selected scope -> export task becomes `failed` with `所选范围没有已标注图片，无法创建导出包`.
- Annotation document exists with an empty array -> image is excluded.
- Annotation document is absent -> image is excluded.
- `includeImages=false` -> annotations are exported for the selected set, but source image bytes are omitted.

### 5. Good/Base/Bad Cases

- Good: a dataset has two train images and only one has a rectangle; every generated annotation file and optional image directory contains only that annotated image.
- Base: all images in the selected scope have annotations; the package contains the entire scoped set.
- Bad: generate empty COCO image entries, empty VOC XML files, blank segmentation masks, or copied source images for unannotated records.

### 6. Tests Required

- Selector unit test covers missing documents, empty annotation arrays, non-empty arrays, and the excluded count.
- Archive test inspects the ZIP contents and proves an unannotated filename does not appear in annotation files or copied image paths.
- Empty-selection test asserts archive creation rejects with the documented error.
- Worker/PostgreSQL integration coverage creates one annotated and one unannotated image, then proves the completed artifact contains only the annotated image.

### 7. Wrong vs Correct

#### Wrong

```sql
SELECT i.* FROM dataset_images i
WHERE i.dataset_id = $1 AND ($2 = 'all' OR i.split = $2)
```

#### Correct

```sql
SELECT i.*, a.annotations
FROM dataset_images i
JOIN annotation_documents a
  ON a.dataset_id = i.dataset_id AND a.image_id = i.id
WHERE i.dataset_id = $1
  AND ($2 = 'all' OR i.split = $2)
  AND jsonb_typeof(a.annotations) = 'array'
  AND jsonb_array_length(a.annotations) > 0
```

## Migrations

- Migrations are idempotent SQL files under `db/migrations/`.
- `server/migrate.ts` records applied migrations in `schema_migrations`.
- Never edit a migration after it has been applied in a shared environment; add the next numbered migration instead.

## Scenario: Task-Neutral Datasets And Standard Training Formats

### 1. Scope / Trigger

- Trigger: changing dataset creation, export formats, training job configuration, annotation materialization, or a trainer dataset adapter.
- Reason: a format selector is a cross-layer execution contract. Persisting a label while the Worker reads a private internal format produces misleading exports and non-reproducible retries.

### 2. Signatures

- `POST /api/v1/datasets` accepts `{ name, description, version, classes }`; it does not require or write `type`.
- `datasets.type TEXT NULL` retains historical values only; API responses may expose them as `legacyType` but no compatibility decision may read them.
- `DataFormat = YOLO | COCO | VOC | COCO_SEGMENTATION | PNG_MASK | COCO_KEYPOINTS`.
- `TrainingDraft.dataFormat: DataFormat | IMAGE_FOLDER` is persisted in `training_jobs.config` and preserved by retry.
- `prepareTrainingFormat(input) -> { configPath, imageCount, classes, format }` owns standard-format materialization and readback.

### 3. Contracts

- `shared/contracts.ts` is the single owner of the task-to-format matrix:
  - detection -> `YOLO | COCO | VOC`
  - segmentation -> `COCO_SEGMENTATION | PNG_MASK`
  - keypoint -> `COCO_KEYPOINTS`
  - sdxl -> `IMAGE_FOLDER`
- Dataset readiness depends on annotation review state, not a legacy task type. Every reviewed dataset is selectable; the chosen format determines which compatible annotations enter a package.
- A training adapter must materialize the selected public format and parse that representation back before invoking the framework. It must not call an internal builder directly while ignoring `dataFormat`.
- COCO Keypoints v1 groups positive, one-based point indices into one object instance per image. Missing indices use `[0, 0, 0]`; the category skeleton remains empty.
- Export and training packages exclude images without at least one annotation representable by the selected format.
- Migration 008 preserves historical dataset types, changes new inserts to `NULL`, migrates `SEGMENTATION` export rows to `PNG_MASK`, expands the export check constraint, and backfills missing training config formats.

### 4. Validation & Error Matrix

- Missing `TrainingDraft.dataFormat` -> `400 VALIDATION_ERROR` with `fields.dataFormat`.
- Task/format mismatch -> `400 VALIDATION_ERROR`, `fields.dataFormat='数据格式与训练任务不兼容'`.
- No compatible annotated image -> Worker marks the job failed with `所选范围没有与 <format> 兼容的已标注图片` and registers no artifact.
- Malformed standard package or empty `train` split -> Worker fails before framework startup and registers no model.
- SDXL format other than `IMAGE_FOLDER` -> API validation failure.

### 5. Good/Base/Bad Cases

- Good: a detection job selects VOC; the Worker writes VOC XML, parses it back into YOLO runtime labels, and logs `VOC` in the persisted task event.
- Base: a migrated dataset still has `legacyType='语义分割'`; a reviewed detection job may use its rectangle annotations with COCO because legacy type is display-only.
- Bad: the UI submits `PNG_MASK` for detection, retry defaults to YOLO instead of preserving the original format, or the Worker always builds YOLO regardless of the selected value.

### 6. Tests Required

- Shared schema/API test asserts every valid matrix pair and a mismatched pair with the stable `VALIDATION_ERROR` code and `dataFormat` field.
- Dataset API/component tests assert creation succeeds without `type` and the create dialog has no task-type control.
- Format adapter tests write and read all six public formats, inspect non-empty native labels/masks/keypoints, and assert the resulting manifest retains `dataFormat`.
- Export selector tests cover unannotated and incompatible-only images; COCO Keypoints tests assert one annotation instance per image and stable missing-index visibility.
- Migration/deployment verification asserts migration 008 is recorded, `datasets.type` accepts `NULL`, and the expanded export constraint is active.
- Retry tests assert `config.dataFormat` is copied unchanged into the new job.

### 7. Wrong vs Correct

#### Wrong

```ts
// The selector is cosmetic: every job silently trains from YOLO.
const prepared = await prepareYoloDataset(dataset);
await runTrainer(prepared.yamlPath);
```

#### Correct

```ts
const prepared = await prepareTrainingFormat({
  task: job.type,
  format: job.config.dataFormat,
  dataset,
  images,
  documents,
});
await runTrainer(prepared.configPath);
```

## Scenario: Annotation Review State Machine

### 1. Scope / Trigger

- Trigger: saving annotations, submitting a completed dataset, reviewing images, creating a training job or creating a dataset export.
- Reason: annotation presence is progress, not quality approval. Readiness must be derived from persisted review decisions rather than `annotated === images`.

### 2. Signatures

- `GET /api/v1/datasets/:datasetId/reviews -> AnnotationReviewSummary`
- `POST /api/v1/datasets/:datasetId/reviews/submit -> AnnotationReviewSummary`
- `POST /api/v1/datasets/:datasetId/reviews/decision` accepts `{ imageIds: string[], decision: 'approve' | 'reject', comment?: string }`.
- `annotation_documents.review_status` is one of `draft`, `submitted`, `approved`, `rejected`; submission/review actor, timestamp, and rejection reason are stored in separate columns.

### 3. Contracts

- Saving a new, rejected, or approved document writes `review_status='draft'` and clears old submission/review metadata. A submitted document is locked.
- Dataset submission requires every `dataset_images` row to have a non-empty annotation document. It moves every non-approved document to `submitted`; already approved images remain approved.
- Only `admin` and `engineer` may decide reviews. Reject requires a non-empty comment. Decisions apply only to currently submitted images.
- Dataset status is derived transactionally: all images approved and total greater than zero -> `可训练`; otherwise any submitted -> `待审核`; otherwise -> `标注中`.
- Training and export creation require dataset status `可训练`. Adding an image resets the dataset to `标注中`.

### 4. Validation & Error Matrix

- Missing/empty image annotation on submission -> `409 ANNOTATION_REVIEW_INCOMPLETE`.
- Save while submitted -> `409 ANNOTATION_REVIEW_LOCKED`.
- Decide a missing image -> `409 ANNOTATION_REVIEW_IMAGE_NOT_FOUND`.
- Decide a draft/approved/rejected image -> `409 ANNOTATION_REVIEW_INVALID_STATE`.
- Reject without a reason -> `400 VALIDATION_ERROR` with `fields.comment`.
- Train/export before all images are approved -> `409 DATASET_REVIEW_REQUIRED`.
- Annotator review decision -> `403 FORBIDDEN`.

### 5. Good/Base/Bad Cases

- Good: save all images, submit once, approve each image -> dataset becomes `可训练`; training/export are accepted.
- Base: approve some images while others remain submitted -> dataset remains `待审核`.
- Bad: set `可训练` when annotation count reaches image count, bypassing reviewer identity and decisions.

### 6. Tests Required

- Repository test asserts revision and review status are checked under a PostgreSQL transaction lock.
- API integration test asserts `标注中 -> 待审核 -> 可训练`, submitted save locking, and annotator decision rejection.
- Validation test asserts reject requires `comment`; gate tests assert training/export reject non-ready datasets.
- Component test asserts submit calls the dataset submission command even after all dirty drafts were already saved.

### 7. Wrong vs Correct

#### Wrong

```sql
UPDATE datasets SET status = CASE WHEN annotated = images THEN '可训练' ELSE '标注中' END;
```

#### Correct

```sql
UPDATE datasets
SET status = CASE
  WHEN image_count > 0 AND approved_count = image_count THEN '可训练'
  WHEN submitted_count > 0 THEN '待审核'
  ELSE '标注中'
END;
```

## Naming Conventions

- Tables and columns use `snake_case`.
- Domain tables use plural nouns: `training_jobs`, `conversion_jobs`, `export_tasks`, `artifacts`.
- Workspace indexes include `workspace_id` first for list queries.

## Common Mistakes

- Forgetting `workspace_id` on task inserts because memory tests pass without PostgreSQL constraints.
- Returning `mapJob(row ?? {})`; this hides failed inserts by converting `undefined` into invalid strings.
- Treating Redis job completion as product completion without registering PostgreSQL task state and artifact metadata.

## Scenario: Live Training Metrics And Resource Telemetry

### 1. Scope / Trigger

- Trigger: changing a trainer progress event, Worker process execution, training detail API, or training-monitor UI.
- Reason: polling `training_jobs` cannot show real Epoch metrics or resource use when the Worker only writes start/end lifecycle state.

### 2. Signatures

- `GET /api/v1/training/jobs/:jobId/observability -> TrainingObservability`
- `TrainingObservability = { metrics: TrainingMetricPoint[]; resources: TrainingResourceSample[] }`
- `training_metrics(workspace_id, job_id, epoch, progress, metrics, created_at, updated_at)` with `UNIQUE(job_id, epoch)`.
- `training_resource_samples(workspace_id, job_id, device, cpu_percent, memory_used_mb, memory_total_mb, gpu_percent, gpu_memory_used_mb, gpu_memory_total_mb, gpu_power_watts, created_at)`.
- Python Runner event: `{ "event": "resource", "device": "cpu|gpu", "cpuPercent": number, "memoryUsedMb": number, ... }`.

### 3. Contracts

- PostgreSQL remains the observability source consumed by the browser; the UI never parses framework stdout or reads artifact paths.
- YOLO metrics are incrementally parsed from `run/results.csv` and normalized to stable JSON keys such as `trainBoxLoss`, `precision`, `recall`, `mAP50`, and `mAP50_95`.
- Structured trainers emit one `progress` event per completed Epoch/step. Segmentation includes `loss` and `mIoU`; keypoint includes `loss` and `oks`; SDXL includes `loss`.
- Each metric upsert also advances `training_jobs.progress`, `epoch`, `metric_value`, `eta`, and `updated_at` while the job is running.
- The Runner samples the training process tree every three seconds. GPU sampling adds `nvidia-smi` utilization, aggregate memory, and power fields when available.
- API responses return at most the latest 500 metric points and 600 resource samples in chronological order.
- Historical Epoch data may be backfilled from a retained YOLO `results.csv`. Resource history cannot be reconstructed after a task finishes.

### 4. Validation & Error Matrix

- Unknown training job -> `404 TRAINING_JOB_NOT_FOUND` from the observability route.
- Malformed stdout or non-JSON framework line -> ignore it; do not fail training.
- Missing YOLO `results.csv` before the first Epoch -> retry on the next polling interval.
- Non-finite metric/resource value -> omit that value or sample; never store JSON `NaN`.
- Telemetry persistence failure -> log the operational error and continue the model process; artifact success remains governed by training output validation.
- GPU sampling command unavailable -> persist CPU/memory fields and omit optional GPU fields.

### 5. Good/Base/Bad Cases

- Good: Epoch 8 completes, `training_metrics` upserts Epoch 8, the job row changes to `8 / 20`, and the UI displays the new point within one polling interval.
- Base: a queued job returns empty metric/resource arrays and the UI displays a waiting state.
- Bad: leave the job at `15%`, infer a fake curve in React, parse logs in the browser, or report host resource placeholders as live telemetry.

### 6. Tests Required

- Parser unit tests assert real Ultralytics CSV headers map to stable metric keys and malformed framework output is ignored.
- API tests assert a known job returns the typed empty observability shape before the Worker reports data.
- Type-check and production build must cover the shared contract through repository, API client, context, and detail page.
- Runner smoke must execute a real child process long enough to emit a finite CPU/memory resource event.
- Deployment verification must create or backfill at least one metric series and query the authenticated observability endpoint.

### 7. Wrong vs Correct

#### Wrong

```ts
await runPython(task);
await pool.query("UPDATE training_jobs SET progress = 100 WHERE id = $1", [taskId]);
```

#### Correct

```ts
await persistTrainingMetric({
  jobId,
  point: { epoch, metrics },
  progress: 15 + epoch * 70 / totalEpochs,
});
```

## Scenario: Versioned Geometry And SDXL Image Documents

### 1. Scope / Trigger

- Trigger: changing annotation save, review, export or SDXL training-data preparation.
- Reason: geometry and image-level text share one optimistic-lock lifecycle and must not diverge between memory and PostgreSQL repositories.

### 2. Signatures

- `PUT /api/v1/datasets/:datasetId/images/:imageId/annotations` accepts `{ revision, annotations, captions?, imageAttributes? }`.
- `annotation_documents` stores `annotations JSONB`, `captions JSONB`, `image_attributes JSONB` under one `revision`.
- `DataFormat` includes `IMAGE_FOLDER`; migration `009_annotation_workspace_and_sdxl_captions.sql` adds columns and expands the export constraint.

### 3. Contracts

- Omitted Caption/image attributes preserve their stored values for backward-compatible geometry-only clients; new clients send all three document sections.
- `captions` permits at most one `primary=true` record. `imageAttributes` contains `includeInSdxl`, `tags` and optional normalized crop.
- Dataset annotation/review completeness counts geometry, Caption or image tags as persisted annotation content.
- ImageFolder selection requires both `includeInSdxl=true` and a non-empty primary Caption. It writes exactly one `metadata.jsonl` row per selected image and preserves split, tags and crop.
- SDXL structured training reads the metadata back and uses `prompt`; it never synthesizes a prompt from geometry labels.

### 4. Validation & Error Matrix

- More than one primary Caption -> `400 VALIDATION_ERROR`.
- Final document has `includeInSdxl=true` without a primary Caption -> `409 SDXL_CAPTION_REQUIRED`.
- ImageFolder scope contains no compatible images -> export/training failure naming `IMAGE_FOLDER`; no artifact is registered.
- Stale revision -> `409 ANNOTATION_REVISION_CONFLICT`, with all document sections unchanged.

### 5. Good/Base/Bad Cases

- Good: revision 3 saves a skeleton plus Caption/crop, returns revision 4, is reviewed, then produces matching ImageFolder metadata and Runner prompt.
- Base: an old client saves only rectangles; existing Caption fields are preserved.
- Bad: store Caption in a second table with a separate revision, or infer Caption from rectangle labels in the Worker.

### 6. Tests Required

- API integration asserts save/read round-trip for Caption and image attributes plus stale revision rejection.
- Repository tests assert PostgreSQL `FOR UPDATE`, next revision and JSONB values.
- Export/training tests read `metadata.jsonl` back and assert prompt, tags and crop in `dataset.json`.
- Migration smoke asserts migration 009, JSONB column types and `IMAGE_FOLDER` constraint acceptance.

### 7. Wrong vs Correct

#### Wrong

```ts
const prompt = annotations.map((item) => item.label).join(', ');
```

#### Correct

```ts
const caption = document.captions.find((item) => item.primary && item.text.trim());
if (document.imageAttributes.includeInSdxl && caption) writeMetadata(image, caption.text);
```
