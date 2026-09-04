# Implementation Plan

## Phase 0: Baseline and Context

- Confirm the approved PRD and design are the active source of truth.
- Preserve the existing reference-workbench changes and identify missing
  behavior against the approved acceptance criteria.
- Run type checks and focused tests before each cross-layer change.

## Phase 1: Contracts, Roles, and Permissions

- Define the single-role permission matrix in shared authorization helpers.
- Audit every frontend route and backend endpoint for administrator, reviewer,
  and annotator access.
- Add regression tests for navigation visibility, direct URL access, and
  unauthorized API calls.
- Preserve explicit Job claiming and task-scoped access.

## Phase 2: Media and Job Scope

- Extend upload and processing contracts for MP4/H.264 originals, extracted
  frame metadata, processing states, retry, and failure reasons.
- Verify Segment/Job creation and frame navigation for extracted frames.
- Add video processing tests without weakening existing image flows.

## Phase 3: Functional Reference Workbench

- Keep the reference-aligned shell and stable layout.
- Complete real rectangle, polygon, polyline, point, and eight-point cuboid
  create/edit/cancel/delete interactions.
- Keep all tools visible for every dataset and allow mixed geometry per image.
- Verify save, autosave, reload, copy-previous-frame, frame navigation, and
  view transforms.
- Do not add merge, split, tracking, interpolation, or SDXL work.

## Phase 4: Review Editing and Attribution

- Add immutable object creator attribution.
- Add final-result field-diff persistence for reviewer saves without a new
  complete annotation version or mouse-operation stream.
- Keep reviewer save separate from approve/reject.
- Add tests for reviewer add/edit/delete and annotator workload preservation.

## Phase 5: Training, Export, and Statistics

- Validate detection, instance/semantic segmentation, and keypoint training
  paths against approved data only.
- Verify real worker artifacts, metrics, conversion outputs, and downloads.
- Add workload and review statistics for each role.
- Preserve immutable training snapshots.

## Phase 6: Deployment and Quality Gate

- Run frontend/backend type checks, unit/interface tests, build, and E2E.
- Build and deploy the current Web image on `5173`.
- Confirm `5174` is not listening and the deployed bundle contains the approved
  workbench and logout behavior.
- Review all changed files against the PRD before finishing the task.

## Validation Commands

```bash
npm run typecheck
npm run typecheck:server
npm test
npm run test:server
npm run build
npm run test:e2e
```

## Rollback Points

- After Phase 1: revert only role/route changes if authorization tests fail.
- After Phase 2: disable video processing while retaining image workflows.
- After Phase 3: disable the workbench route without touching stored documents.
- After Phase 4: disable reviewer diff UI while retaining audit data.
- Never roll back by deleting training snapshots, model artifacts, or audit
  records.
