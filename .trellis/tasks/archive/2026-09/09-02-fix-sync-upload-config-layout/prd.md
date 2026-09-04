# Fix synchronization, task upload validation, and preprocessing layout

## Goal

Fix the recurring synchronization failure dialog, make annotation task uploads conform to the API contract, and align preprocessing option layout and control dimensions.

## Requirements

- Restore successful authenticated dashboard synchronization against the current
  PostgreSQL schema. The statistics request must not assume `workspace_id`
  columns on tables that do not have them, and one failing optional statistics
  request must not hide the other successfully loaded dashboard data.
- Creating a dataset from the data center must send a payload that conforms to
  the shared dataset contract before the API request is made. The form must
  validate the same minimum/maximum constraints as the API and report the
  invalid field instead of presenting a generic upload failure.
- Dataset media uploads must preserve the intended source type when the
  browser provides an empty or generic MIME type. Recognized image, video, and
  archive extensions must map to the corresponding source type and MIME type
  at the upload boundary.
- The `使用压缩块` and `启用 Z 顺序` preprocessing options must use the same
  field grid, outer frame, control height, and spacing as the neighboring
  preprocessing parameters in both the create-task and start-processing
  dialogs.
- Keep the existing role permissions, upload-session resume behavior, and
  processing payload fields unchanged apart from the fixes above.

## Acceptance Criteria

- [ ] An authenticated page load and browser refresh complete without a
  `数据同步失败` toast; `/api/v1/annotation-statistics` returns 200 in the
  deployed PostgreSQL environment.
- [ ] Invalid dataset form values are rejected before `POST /api/v1/datasets`
  and identify the invalid field; a valid image, archive, or video task
  creation completes its dataset creation and upload flow.
- [ ] Upload type/MIME inference is deterministic for supported extensions
  even when `File.type` is empty or `application/octet-stream`.
- [ ] The two boolean preprocessing options have the same measured outer
  height and input/control width as the neighboring fields at desktop and
  mobile layouts.
- [ ] Regression tests cover the PostgreSQL statistics query shape, dataset
  form validation/media inference, and the preprocessing option rendering.
- [ ] `npm run typecheck`, `npm run typecheck:server`, `npm test -- --run`,
  `npm run build`, and a deployed browser smoke check pass.

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- The production reproduction returned `500 INTERNAL_ERROR` from
  `/api/v1/annotation-statistics`; API logs identified direct references to a
  missing `workspace_id` column on `annotation_jobs`.
- The production browser reproduced the generic synchronization toast. Valid
  image, ZIP, and MP4 upload fixtures currently succeed, so the upload fix
  must cover the invalid-value path without regressing those valid flows.
- Do not add tracking/interpolation, new annotation versions, or unrelated UI
  redesign in this task.
