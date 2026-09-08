# Database Guidelines

> Database patterns and conventions for this project.

---

## Overview

<!--
Document your project's database conventions here.

Questions to answer:
- What ORM/query library do you use?
- How are migrations managed?
- What are the naming conventions for tables/columns?
- How do you handle transactions?
-->

(To be filled by the team)

## Scenario: Annotation Review and Media Processing Synchronization

### 1. Scope / Trigger
- Trigger: Any change that updates annotation Job state, dataset review state, processing runs, or dataset image metadata.
- The repository must update the source record and every derived status that is displayed by the data center in the same transaction where possible.

### 2. Signatures
- `Repository.claimAnnotationReviewJob(id, reviewerId, isAdmin?)` claims the selected submitted Job.
- `POST /api/v1/annotation-jobs/:jobId/review-claim` claims one selected review Job.
- `PUT /api/v1/datasets/:datasetId/images` stores the uploaded image `width` and `height`.

### 3. Contracts
- A selected review claim may only transition `submitted -> reviewing`; it must not substitute another Job.
- A Job review may transition to `approved` or `rework` and must recompute the dataset aggregate status.
- Direct image uploads must persist positive source dimensions so annotation coordinates use the image coordinate system.
- Resource-processing workers must describe direct image assets before inserting or refreshing `dataset_images`; reprocessing an existing row must also restore `width` and `height`.
- Processing completion is observed through `processing_runs`, source asset processing status, and a fresh dataset read.

### 4. Validation & Error Matrix
- Missing, non-submitted, self-submitted, or already-claimed review Job -> `409 ANNOTATION_JOB_REVIEW_UNAVAILABLE`.
- Invalid image bytes or missing dimensions -> `400 INVALID_IMAGE`.
- A reviewer outside the dataset reviewer list cannot claim a selected Job.

### 5. Good/Base/Bad Cases
- Good: Select Segment 2 while Segment 1 is also submitted; only Segment 2 becomes `reviewing`.
- Base: Approve the final submitted Job; its Job is `approved` and the dataset becomes `可训练`.
- Bad: Update only the Job row or only the processing run and leave the dataset aggregate stale.

### 6. Tests Required
- API test asserts selected review claim returns the requested Job and leaves another submitted Job unchanged.
- Repository test asserts approve/reopen recomputes dataset status.
- API test asserts a non-square upload returns and persists its true dimensions.
- Frontend test asserts processing polling invokes dataset refresh.

### 7. Wrong vs Correct
#### Wrong
```typescript
const openedJob = await repository.claimNextAnnotationReviewJob(datasetId, reviewerId);
```

#### Correct
```typescript
const openedJob = await repository.claimAnnotationReviewJob(jobId, reviewerId, isAdmin);
```

---

## Query Patterns

## Scenario: Global Data Center Catalog

### 1. Scope / Trigger
- Applies to task directory, dataset creation/binding, tree reads, and release cleanup (migrations 024/025).

### 2. Signatures
- `GET/POST /api/v1/task-categories`, `PATCH /task-categories/:id`.
- `POST /api/v1/task-categories/:id/task-types`, `PATCH /task-types/:id`.
- `GET /api/v1/data-center/tree` and `PATCH /datasets/:datasetId/task-type`.
- `npm run datasets:reset-catalog` previews; `npm run datasets:reset-catalog -- --apply` performs the one-time reset.

### 3. Contracts
- All directory/tree/binding APIs require admin. Catalog and tree queries are global, with no workspace predicate.
- Dataset creation requires `taskTypeId`; both task and parent must be enabled. Classification does not constrain annotation geometry or model type.
- Codes are server-generated, unique and immutable. Task names are unique within the category, including disabled tasks. There are no physical directory delete endpoints.
- Binding takes `{ taskTypeId, expectedTaskTypeId, confirmed: true }`; update and `dataset.task_type.update` audit commit together.
- Tree takes `from/to` dates, browser `timezoneOffset` in minutes west of UTC, category/task codes, literal `query`, page and pageSize. End date is inclusive; SQL uses next-day exclusive bound. Counts and leaves use one repeatable-read snapshot; retry serialization failures at most twice.
- Reconcile actual image/document review states before filtering `可训练`; do not write unchanged aggregates. Reopening clears `approved_at`.
- Cleanup uses `DATABASE_URL`, optional `REDIS_URL`, `FORGE_ARTIFACT_ROOT`; stop API/workers and back up DB first. It removes scoped terminal queue tasks and DB rows, moves managed directories to a recovery sibling, and writes `dataset.catalog_reset`. A repeated invocation is a no-op, protecting post-release datasets. Never put reset in service startup.

### 4. Validation & Error Matrix
- Non-admin -> 403; missing task, invalid date range, editable code or missing confirmation -> 400.
- Disabled parent/task -> 409 `TASK_TYPE_UNAVAILABLE`; duplicate name/code or stale expected binding -> 409.
- Active task during reset -> fail without deleting dataset records; failed file/DB operation rolls back DB and restores moved directories.
- Migration 025 with unclassified historical datasets -> fail with explicit reset instruction.

### 5. Good/Base/Bad Cases
- Good: disabled business task remains visible with historical approved datasets and cannot receive new bindings.
- Base: empty catalog has five categories and no business tasks; new dataset creation waits for an administrator-created task.
- Bad: infer annotation geometry from category name, silently drop incompatible export annotations, or apply workspace filtering to the tree.

### 6. Tests Required
- `server/taskCatalog.test.ts`: counts, pagination, date boundary, disabled names, audit and stale binding.
- `server/taskCatalog.pg.test.ts`: run only with disposable `CATALOG_TEST_DATABASE_URL`; migrations, parallel tree reads, SQL constraints, binding concurrency, cleanup recovery and idempotency.
- `server/api.test.ts`: admin enforcement, strict payloads and missing classification.
- `src/pages/DataCenterPage.test.tsx` and `VITE_API_ENABLED=true npx playwright test e2e/data-center.spec.ts`: filters, details, rebind, directory maintenance and desktop/mobile overflow.

### 7. Wrong vs Correct
- Wrong: `DELETE FROM datasets` in an automatic startup migration.
- Correct: reviewed reset preview, database backup, stopped writers, explicit `--apply`, then migration and restart on existing ports.

<!-- How should queries be written? Batch operations? -->

(To be filled by the team)

---

## Migrations

<!-- How to create and run migrations -->

(To be filled by the team)

---

## Naming Conventions

<!-- Table names, column names, index names -->

(To be filled by the team)

---

## Common Mistakes

<!-- Database-related mistakes your team has made -->

- Do not trust a persisted `datasets.status` value as the sole source of truth. It is derived from `dataset_images` and `annotation_documents`, so dataset reads must reconcile the aggregate before returning data to the data center or workflow guards. This repairs rows left stale by older review paths and keeps the displayed status aligned with the final document review states.
- Dataset exports are dataset-scoped. New export requests must not select annotation Jobs or Segments; the export worker must join approved annotation documents and filter out documents with no exportable annotation content before materializing the ZIP. Keep the historical `export_tasks.job_ids` column only for storage compatibility and do not use it to filter new exports.

(To be filled by the team)
