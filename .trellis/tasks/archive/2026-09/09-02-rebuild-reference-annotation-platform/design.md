# Technical Design

## Design Principles

1. The reference platform is the interaction and layout baseline.
2. The current project remains the source of truth for authentication,
   permissions, Jobs, review state, persistence, training snapshots, exports,
   and artifacts.
3. Frontend state must not become a second business state machine.
4. Attribution and audit data are separate from the current annotation
   document so reviewer edits do not erase annotator workload.

## Layer Boundaries

### Shared Contracts

Extend the shared annotation and audit contracts only where the current
document cannot express the approved behavior. Annotation objects own immutable
creator metadata. Reviewer save events own field-level before/after changes.
Task type remains a training/export concern and does not restrict workbench
tools.

### Backend

- `server/api.ts`: authentication, role guards, media upload/process actions,
  Job/review transitions, reviewer edit audit endpoint, statistics, training,
  conversion, export, and download authorization.
- `server/repository.ts`: transactional document saves, creator attribution,
  final-result reviewer diffs, statistics queries, and task-scoped reads.
- `server/mediaProcessor.ts` and `server/mediaProcessing.ts`: video frame
  extraction, metadata, segmentation, progress, retry, and failure details.
- `db/migrations/`: additive schema for video metadata, reviewer field diffs,
  attribution, and workload aggregation. Existing approved training snapshots
  remain immutable.

### Frontend

- `src/context/AppContext.tsx`: session, role-aware API actions, and shared
  server data.
- `src/pages/`: role-visible data center, task/review, training, conversion,
  and admin routes.
- `src/components/annotation/`: reference workbench, geometry, tool state,
  frame navigation, object panel, and draft persistence.
- `src/styles.css`: stable workbench dimensions and reference-aligned states.
- `src/utils/`: pure geometry, shortcut, attribution display, and format
  helpers. Do not duplicate cross-layer parsing in components.

## Data Flow

### Media

`upload -> stored original -> processing queue -> extracted frame records ->
Segments/Jobs -> task-scoped API -> workbench frame navigation`.

Each extracted frame carries source video ID, frame index, timestamp, and split.
The original video is retained separately from derived frame objects.

### Annotation and Review

`workbench draft -> normalized AnnotationDocument -> revision-checked save ->
current document + optional reviewer field-diff audit -> submit/review state
machine`.

Annotator object creator fields are written when the object is first created.
Reviewer edits send a compact diff derived at save time. The server validates
authorization and persists the diff in the same transaction as the document
update. No mouse event stream and no extra complete document version are
stored.

### Training and Export

`approved Jobs -> server-selected immutable training snapshot -> format
materialization -> async worker -> artifact/model/conversion record -> download`.

Training and export validation happens at the backend boundary. The workbench
does not hide tools based on task type, but incompatible geometry is reported
when a format is materialized.

## Workbench State

Separate four state categories:

1. server facts: session, dataset, Segment, Job, review state, revision;
2. current frame document: annotations, captions, attributes;
3. editor state: active tool, draft geometry, selection, view transform,
   panels, and local history;
4. save queue: immutable per-image snapshots and conflict outcomes.

Shape geometry is stored internally in image pixel coordinates and converted at
the persistence boundary to the project's normalized contract. SVG transforms
must use the inverse screen transform for pointer coordinates so zoom, pan, and
rotation do not move objects incorrectly.

All tools stay visible. Rectangle, polygon, polyline, point, and cuboid each
have explicit create/finish/cancel/edit states. Cuboid uses eight projected
points. Merge and split are excluded. Semantic segmentation uses polygon
regions that the export layer rasterizes to masks.

## Role Enforcement

Use one shared role matrix for navigation and API authorization. Frontend
visibility is a usability layer, not a security boundary. Annotator reads and
writes must be scoped to claimed Jobs; reviewer reads and writes must be scoped
to claimed review Jobs; administrator bypasses resource ownership but still
produces audit records.

## Statistics Model

Object creator metadata remains stable. A reviewer field-diff record references
the current object ID, reviewer, and changed fields. Aggregation uses creator
metadata for annotator-created counts and diff actor/operation categories for
reviewer counts. A reviewer deletion is an audit event and never mutates the
historical creator count.

## Compatibility and Rollback

- Keep the current `AnnotationDocument` and revision contract unless an
  additive field is required.
- Keep training snapshots immutable and do not reinterpret existing artifacts.
- Use additive migrations and make new audit/statistics reads tolerant of
  empty data.
- Disable a new UI route as the first rollback step; do not delete persisted
  audit data or snapshots during rollback.
- Port `5174` is not a deployment target.
