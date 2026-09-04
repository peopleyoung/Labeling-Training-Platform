# Technical Design

## Change Boundary

The smallest behavior gap is at three existing boundaries: the PostgreSQL
statistics query does not match the deployed schema, the data-center form
lets API-invalid values reach the dataset endpoint, and the boolean processing
fields use a different CSS structure from numeric fields.

Expected implementation files:

- `server/repository.ts`: scope statistics through `datasets.workspace_id`
  joins instead of nonexistent columns.
- `server/repository.test.ts` or a focused repository test: lock the SQL
  contract and returned statistics behavior.
- `src/context/AppContext.tsx` or a shared upload utility: normalize media
  source type and MIME from browser metadata plus file extension.
- `src/pages/DatasetsPage.tsx`: validate the assembled create-task payload
  with the shared schema and render boolean options with the normal field
  structure.
- `src/pages/DatasetsPage.test.tsx` or focused frontend tests: cover invalid
  form submission and the field structure/dimensions.
- `src/styles.css`: make the boolean preprocessing fields use the same stable
  field/control dimensions as neighboring fields.

No database migration is needed: `annotation_documents`, `annotation_jobs`,
and `audit_logs` intentionally do not have `workspace_id`; datasets already
provide the workspace boundary for annotation data.

## Data Flow

### Statistics

`GET /api/v1/annotation-statistics` -> `PgRepository.getAnnotationStatistics`
-> `annotation_documents` / `annotation_jobs` / `audit_logs` joined or scoped
through `datasets.workspace_id` -> role-specific aggregation -> dashboard.

The jobs query joins `datasets` on `dataset_id`. The audit query joins datasets
using the existing `metadata->>'datasetId'` field and filters the current
workspace. The document query keeps its existing dataset join.

### Dataset Creation and Upload

Form state -> `readProcessingConfig` -> shared `datasetCreateSchema.safeParse`
-> `ApiClient.createDataset` -> API `datasetCreateSchema` -> upload boundary.

For each selected file, a single media metadata normalizer chooses:

| Source | Supported extensions | MIME fallback |
| --- | --- | --- |
| image | `.jpg`, `.jpeg`, `.png`, `.webp` | `image/jpeg`, `image/png`, `image/webp` |
| video | `.mp4`, `.mov`, `.avi`, `.mkv` | corresponding video MIME |
| archive | `.zip`, `.tar` | `application/zip`, `application/x-tar` |

An explicit supported browser MIME remains authoritative. Empty or generic
MIME values use the extension fallback. Unknown files remain archives only
when the UI permits them; the form's accept list remains the user-facing
filter.

## Error Handling

Client-side schema failures are converted to a concise field-specific error
before any dataset request. Server validation remains authoritative for direct
API clients. Statistics query failures are fixed at the data layer; the
existing aggregate load behavior stays intact unless a separate optional
request still fails.

## Explicitly Out Of Scope

- Changing the database schema to add redundant workspace columns.
- Changing upload chunk sizes or resumable-session state transitions.
- Changing annotation permissions, annotation geometry, model training, or
  export behavior.
- Redesigning unrelated forms or the general modal system.
