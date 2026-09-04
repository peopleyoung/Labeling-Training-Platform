# Reference-Aligned Annotation Platform

## Goal

Deliver a functional annotation platform aligned with the reference platform's
annotation workbench, while preserving the current project's authenticated
business workflow. The first release must implement real operations and
persisted outcomes; visual similarity alone is not sufficient.

This document records the product consensus confirmed on 2026-09-02. It is the
source of truth for this task and supersedes earlier assumptions in this task's
planning artifacts.

## Roles and Access

Each user has exactly one business role:

- **Administrator**: full system access. Can manage users, datasets, label
  schemas, media processing, tasks, Jobs, reviews, training, conversions,
  exports, models, settings, and audit data.
- **Reviewer**: can inspect datasets, claim review Jobs, edit annotations,
  save, approve or reject, train from approved data, convert models, and
  download approved datasets, model artifacts, and conversion artifacts. Cannot
  manage users, delete foundational datasets, or change frozen label schemas.
- **Annotator**: sees only the data-center workflow and data relevant to the
  annotator's Jobs. Can claim Jobs, annotate, save drafts, and submit for
  review. Cannot access training, conversion, model, administration, or other
  users' data.

The frontend must hide unavailable navigation, but the backend must enforce the
same permissions on every protected endpoint. A URL or manually crafted
request must not bypass role restrictions.

## Dataset and Media Workflow

- Administrators create datasets, configure labels and processing, and open
  annotation tasks.
- The platform accepts images and videos. The first release supports MP4/H.264
  video uploads, keeps the original video, and extracts ordered image frames
  with frame index, timestamp, and source metadata.
- Administrators can configure frame interval, start/end frame, Segment size,
  overlap, image quality, block size, compression-block behavior, and Z order.
- Processing exposes stable states: uploading, processing, ready, failed, and
  cancelled. Failures retain an actionable reason and support administrator
  retry or deletion.
- Annotators work only on explicitly claimed Segment/Job ranges. Opening a
  task must not silently claim a Job.
- The review unit is a Segment/Job. A dataset release is trainable/exportable
  only after all required Jobs are approved.
- First release does not implement automatic tracking or interpolation. It
  does support copying the previous frame's annotations into the current
  frame.

## Annotation Workbench

The workbench follows the reference platform's structure: top navigation and
actions, frame navigation, left tool rail, central canvas, object/label/Issues
panel, appearance controls, and stable status feedback.

All tools remain visible and usable regardless of dataset task type. A single
image may contain mixed geometry types. Task type is used by training and
export compatibility checks, not to disable canvas tools.

Required tools and behavior:

- rectangle: draw, select, move, eight-direction resize, and delete;
- polygon: continuous point creation, close/finish, vertex editing, and
  delete;
- polyline: continuous point creation, double-click/Enter finish, vertex
  editing, and delete;
- points/keypoints: create, move, edit, and delete;
- cuboid: reference-aligned eight-point projection interaction, whole-object
  move, vertex editing, and delete;
- select, copy, paste, undo, redo, lock, hide, occlusion, z-order, label
  selection, color display, outline/label visibility, zoom, pan, rotate, fit,
  grid, fullscreen, frame navigation, save, autosave, and cancel;
- reviewer-only workflow actions: save edits, approve, reject with a required
  reason, and return for rework.

The first release does not implement merge, split, automatic tracking, or
interpolation. Semantic segmentation uses polygon regions and produces masks
at export time. Instance segmentation uses one or more polygon objects per
instance. Keypoint names, ordering, and optional skeleton are administrator
configuration.

Saving is separate from submitting. Autosave saves a draft and never changes
the Job status. Leaving a dirty workbench prompts the user and does not silently
discard the local draft. Save conflicts retain the local draft and provide
explicit server-version and local-draft choices.

## Review Edits and Attribution

Reviewers may edit the current annotation document and then save and approve
it. The platform does not create a new complete annotation version for this
operation. The current document is updated in place.

Object attribution is independent from the current document's latest editor:

- an object created by an annotator retains its annotator creator and creation
  time even when a reviewer edits it;
- an object created by a reviewer is attributed to that reviewer;
- reviewer deletion does not erase the annotator's original creation count;
- reviewer modifications are distinguishable from annotator creation.

On save, persist one final-result audit event for the reviewer change. It must
contain the affected object, changed fields, before values, after values,
reviewer, and time. Do not persist the sequence of mouse operations. A save
while still reviewing keeps the Job in review; approval is a separate action.

## Workload and Audit Statistics

The platform records auditable actions including user management, Job claims,
saves, submissions, approvals, rejections, reviewer edits, training,
conversion, export, and download.

Statistics must distinguish:

- annotator-created object count;
- final effective object count;
- completed frame count;
- completed Job/Segment count;
- reviewer-added, modified, and deleted object counts;
- approval and rejection rates.

Administrators can view all statistics. Reviewers can view their review and
modification statistics. Annotators can view their own work, rejection count,
and review feedback, but not another annotator's workload.

## Training, Conversion, and Export

The first release provides real, asynchronous training for:

- object detection;
- instance segmentation;
- semantic segmentation;
- keypoint detection.

Default model families are YOLOv8, SegFormer, and HigherHRNet. Training must
produce a real model artifact, metrics, progress/events, and a downloadable
result. CPU/GPU capability and unsupported configurations must be reported
honestly; fake progress is not acceptable.

Supported first-release data outputs are:

- detection: YOLO, COCO, VOC;
- instance segmentation: COCO segmentation;
- semantic segmentation: PNG masks plus class mapping JSON;
- keypoints: COCO Keypoints.

Training, conversion, and export can use only an approved dataset release and
must preserve the immutable training snapshot used by the queued task. SDXL is
not a first-release requirement.

## Deployment

- The current production Web service runs on port `5173`.
- Port `5174` remains closed and must not be used by the deployed Web service.
- Acceptance uses independent administrator, reviewer, and annotator accounts.

## Acceptance Criteria

- [ ] Role menus and backend endpoints enforce the exact three-role matrix.
- [ ] Administrator can create users, configure labels, process media, open
      tasks, and manage all downstream resources.
- [ ] Reviewer can claim review Jobs, edit/save/approve/reject, train from
      approved data, convert models, and download authorized artifacts.
- [ ] Annotator can only access own task-scoped data, all annotation tools,
      save drafts, and submit for review.
- [ ] Images and MP4/H.264 videos complete upload, processing, frame metadata,
      Segment/Job generation, failure, retry, and task-scope flows.
- [ ] Every required tool performs real draw, select, edit, cancel, delete,
      save, and reload behavior; cuboid follows the eight-point interaction.
- [ ] Mixed geometry is allowed on one image and tools are not hidden by task
      type.
- [ ] Reviewer edits update the document in place and produce final-result
      field-diff audit data without an extra complete version.
- [ ] Annotator and reviewer contributions remain separable in statistics.
- [ ] Approval gates training, conversion, and export; generated artifacts are
      real and downloadable.
- [ ] `npm run typecheck`, `npm run typecheck:server`, `npm test`,
      `npm run build`, and runnable end-to-end acceptance pass.

## Explicit Non-Goals

- no merge or split tool;
- no automatic tracking or interpolation;
- no SDXL first-release workflow;
- no multi-tenant expansion;
- no complete CVAT service or private reference-platform bundle;
- no hidden implicit Job claim on page open;
- no speculative reference behavior without evidence.
