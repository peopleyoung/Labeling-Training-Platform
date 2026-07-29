# State Management

## State Categories

- Route and form state stays local with `useState`.
- Cross-route product data and commands use `AppContext`: datasets, training jobs, model versions, conversion tasks, session, exports, and toast messages.
- Product collections initialize as empty arrays in every runtime mode. Static capability metadata belongs in `data/catalog.ts`.
- Route identity belongs in React Router paths and query strings, for example `/conversions?source=<modelId>`.

## Scenario: API Mode Data Boundary

### 1. Scope / Trigger

- Trigger: any page that reads datasets, training jobs, model versions, conversions, or creates export/training/conversion tasks.
- Reason: in API mode the backend and database are the source of truth; pages must not keep importing fixture arrays as business state.

### 2. Signatures

`useApp()` exposes:

```ts
datasets: Dataset[];
jobs: TrainingJob[];
models: ModelVersion[];
conversions: ConversionTask[];
gpuEnabled: boolean;
createDatasetExport(datasetId: string, format: ExportTask['format']): Promise<string>;
createTrainingJob(draft: TrainingDraft, datasetName: string): Promise<string>;
createConversion(input: {
  modelName: string;
  modelVersion: string;
  format: ConversionFormat;
  precision: string;
  target: string;
}): Promise<string>;
loadAnnotationDocument(datasetId: string, imageId: string): Promise<AnnotationDocument>;
saveAnnotationDocument(input: {
  datasetId: string;
  imageId: string;
  revision: number;
  annotations: AnnotationRecord[];
  captions?: ImageCaption[];
  imageAttributes?: AnnotationImageAttributes;
}): Promise<AnnotationDocument>;
loadAnnotationReview(datasetId: string): Promise<AnnotationReviewSummary>;
submitAnnotationReview(datasetId: string): Promise<AnnotationReviewSummary>;
decideAnnotationReview(
  datasetId: string,
  input: AnnotationReviewDecisionInput,
): Promise<AnnotationReviewSummary>;
```

### 3. Contracts

- In local mode, `AppContext` initializes datasets, jobs, models, conversions, and annotations as empty collections and mutates them only after explicit user commands.
- In API mode, `AppContext` reads `/datasets`, `/training/jobs`, `/models`, and `/conversions` after login/session restore.
- `AppContext` reads `/capabilities` independently of session state and exposes `gpuEnabled`; it defaults to `false` until the API confirms availability.
- `AnnotationPage` loads and saves one document through `loadAnnotationDocument()` and `saveAnnotationDocument()`; the page only adapts the shared rectangle geometry to its SVG rendering shape.
- Context commands used by page effects must keep a stable function identity when they update internal caches. Read mutable cache snapshots through a ref or functional state boundary; never make the cache written by a command one of that command's callback dependencies.
- Page effects that load an entity document depend on primitive route identities such as `datasetId` and `imageId`, not on collection-derived object references that can be replaced by a background refresh.
- Pages may import `data/catalog.ts` only for display constants such as `taskLabels` and `formatDescriptions`; production source must not import test fixtures.
- Pages must create training, conversion, and export tasks through `useApp()` commands so API errors are mapped consistently.
- Commands return the created task id for navigation or local confirmation.

### 4. Validation & Error Matrix

- API returns `UNAUTHORIZED` during session restore -> `logout()` and force login.
- API command rejects -> command caller catches and calls `notify(title, message, 'error')`.
- API returns validation/compatibility error -> UI displays `ApiClientError.message`; field-level rendering can use `fields` when implemented.
- API returns `GPU_UNAVAILABLE` -> keep training/conversion controls disabled and display the API message; do not create a local queued task.
- Annotation save returns `ANNOTATION_REVISION_CONFLICT` -> keep the current drawing, load the latest server revision separately, and require an explicit choice between loading the server copy or retrying the current drawing against that latest revision.
- Empty API result -> page renders empty table/list from context arrays rather than falling back to stale fixtures.

### 5. Good/Base/Bad Cases

- Good: `DatasetsPage` reads `const { datasets, createDatasetExport } = useApp()`.
- Base: `DashboardPage` derives counts from `datasets`, `jobs`, and `models` in context.
- Bad: `TrainingWizardPage` imports `datasets` from `data/mockData.ts` and submits a task against an API dataset id that may not exist.

### 6. Tests Required

- Typecheck must catch the async command signatures.
- Vitest must verify empty local routes without API env vars and prevent training submission without a real dataset.
- Playwright must cover clean empty states, capability controls, guarded annotation routes, and mobile navigation.
- API-mode regression tests should verify that login/session load populates context data from service responses.
- Annotation API tests must save revision `0 -> 1 -> 2`, read the same revision back, and reject a stale revision.
- Annotation context tests must verify that caching a loaded document does not change `loadAnnotationDocument` and trigger a second effect request.
- Annotation UI tests must keep unsaved geometry visible after a conflict and cover both explicit recovery actions.

### 7. Wrong vs Correct

#### Wrong

```tsx
import { datasets } from '../data/mockData';

const selectedDataset = datasets.find((item) => item.id === draft.datasetId);
```

For effect-driven cache loading, this dependency cycle is also wrong:

```tsx
const loadDocument = useCallback(async (id: string) => {
  const document = await client.load(id);
  setDocuments({ ...documents, [id]: document });
}, [client, documents]);
```

#### Correct

```tsx
const { datasets } = useApp();

const selectedDataset = datasets.find((item) => item.id === draft.datasetId);
```

Keep the command stable and store the latest cache snapshot separately:

```tsx
const documentsRef = useRef(documents);
const loadDocument = useCallback(async (id: string) => {
  const document = await client.load(id);
  const next = { ...documentsRef.current, [id]: document };
  documentsRef.current = next;
  setDocuments(next);
}, [client]);
```

## Scenario: Multi-Image Annotation Draft Session

### 1. Scope / Trigger

- Trigger: annotation work that allows the operator to move between images before saving.
- Reason: the API persists one optimistic-lock document per image, while the UI presents one dataset-wide labeling session.

### 2. Signatures

```ts
interface AnnotationDraft {
  annotations: Annotation[];
  captions: ImageCaption[];
  imageAttributes: AnnotationImageAttributes;
  revision: number;
  dirty: boolean;
  reviewStatus: 'draft' | 'submitted' | 'approved' | 'rejected';
  reviewComment?: string;
}

draftsRef: Record<imageId, AnnotationDraft>;
saveAnnotationDocument({ datasetId, imageId, revision, annotations, captions, imageAttributes }): Promise<AnnotationDocument>;
```

### 3. Contracts

- Before changing the `image` query parameter, explicitly cache the current image annotations and revision, then put the page into `loading` state.
- Loading an image first restores its session draft; only images without a draft read the server document.
- `Save all` processes dirty drafts sequentially through the per-image API so every request carries that image's own revision.
- `Submit all` first saves dirty drafts, then calls the dataset review submission API even when there were no dirty drafts. The backend validates that every dataset image has a non-empty persisted annotation document.
- Review mode is route state (`mode=review`). It preserves that query parameter during image navigation and keeps drawing, class editing, geometry inputs, undo, redo, and delete actions read-only.
- Each successful image becomes clean immediately. If a later image fails, already persisted images remain clean and unsaved images remain dirty.
- Drafts are page-session state. A browser refresh still restores the last server versions.

### 4. Validation & Error Matrix

- Current image has an unfinished polygon -> block image navigation until it is completed or undone.
- Save starts with an unlabeled object in any dirty image -> reject the whole batch and identify that image.
- One image returns `ANNOTATION_REVISION_CONFLICT` -> stop the batch, navigate to that image, preserve its draft, and expose explicit reload/overwrite actions.
- Non-conflict failure after partial success -> report the saved count and keep remaining drafts dirty.

### 5. Good/Base/Bad Cases

- Good: edit image A, navigate to B, edit B, save once -> two requests with independent revisions and geometries.
- Base: click save with no dirty drafts -> no API request and an informational message.
- Bad: change the route first and let an effect cache the old component state under the new image id; this copies annotations between images.

### 6. Tests Required

- Component test must create different geometry on two images, navigate without saving, invoke one save command, and assert two requests retain their own image ids, revisions, and coordinates.
- Zoom component test must assert working zoom-in/zoom-out buttons and the `25%` lower bound.
- Browser verification must confirm stage pixel width changes at `25%`, `100%`, and above `100%`, where the scroll area becomes scrollable.

### 7. Wrong vs Correct

#### Wrong

```tsx
setSearchParams({ image: next.id });
// A later effect sees next.id with the previous image's annotations.
```

#### Correct

```tsx
draftsRef.current[currentImageId] = { annotations, revision, dirty: true };
setSyncState('loading');
setSearchParams({ image: next.id });
```

## Global Command Contract

Pages create product records only through `useApp()`. In API mode these commands call `ApiClient`; in demo mode they create typed local queued records and emit a toast.

## Boundary Behavior

- Refreshing local mode restores empty product collections. Refreshing API mode restores the session from local storage and reloads product data from the API.
- Call `notify` after every simulated mutation.
- Do not add a state management package until a real backend/cache contract requires it.

## Clean Workspace Error Matrix

- Empty collection -> render an explicit empty state; never select index `0` as a fallback record.
- Missing route dataset or image -> render a guarded annotation empty state; do not synthesize an image id.
- Training draft without a compatible dataset -> disable progression and submission.
- Conversion form without a model -> disable task creation and leave artifact estimates unknown.

## Clean Workspace Wrong vs Correct

### Wrong

```tsx
const model = models.find((item) => item.id === sourceId) ?? models[0];
const size = '74 MB';
```

### Correct

```tsx
const model = models.find((item) => item.id === sourceId);
return model ? <ConversionSummary model={model} /> : <EmptyState />;
```
