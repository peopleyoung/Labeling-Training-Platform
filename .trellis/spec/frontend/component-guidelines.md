# Component Guidelines

## Component Pattern

Use named function components with explicit inline props. Shared visual components live in `src/components`; routes compose them in `src/pages`.

```tsx
export function StatusBadge({ status }: { status: JobStatus }) {
  return <span className={`status-badge status-${status}`}>{statusLabels[status]}</span>;
}
```

Use semantic buttons for actions, links for navigation, and `aria-label` on icon-only controls. Dialogs require `role="dialog"`, `aria-modal="true"`, and an accessible label.

## Styling

- Use `src/styles.css` design tokens and media queries.
- Name classes by component ownership, for example `conversion-format-grid`.
- Operational surfaces use radii of 8px or less; avoid nested visual cards and marketing hero layouts.

## Annotation Event Contract

> **Warning**: Capture pointer coordinates synchronously. React clears `event.currentTarget` after an event handler returns.

```tsx
// Wrong: the updater runs after the event is no longer current.
setPolygonPoints((points) => [...points, getPoint(event)]);

// Correct: capture the normalized value in the handler.
const point = getPoint(event);
setPolygonPoints((points) => [...points, point]);
```

Annotation positions are percentages in a `0..100` SVG view box over the bitmap so they remain aligned as the stage scales.

The annotation stage must adopt the loaded bitmap's natural aspect ratio. The SVG overlay and bitmap must share the exact rendered box; do not use a fixed stage ratio with `object-fit: contain`, because the resulting letterbox offsets make saved geometry appear displaced.

Rectangle interactions use an explicit pointer session:

- Dragging the rectangle body moves it without changing its size.
- Eight edge/corner handles resize it with a non-zero minimum size.
- The active gesture lives in a mutable ref, not only React state. `pointerdown`, `pointermove`, and `pointerup` can arrive before a render commits, so every handler must read the same synchronous session.
- `pointerup` recalculates geometry from its own final coordinates before committing. This preserves short or coalesced drags where the browser does not deliver an observable final `pointermove`.
- Movement and resizing are clamped to the normalized `0..100` image bounds through pure helpers in `utils/annotation.ts`.
- Selection, dragging, and resizing remain local UI state; persisted annotation geometry changes only after a successful save.

```tsx
// Wrong: pointerup may still observe the previous render's null state.
setDragStart(start);
if (dragStart && draftRect) commit(draftRect);

// Correct: keep gesture identity synchronous and use the release coordinate.
pointerSessionRef.current = { pointerId, start, draft };
const session = pointerSessionRef.current;
const finalRect = rectangleFromPoints(session.start, releasePoint);
commit(finalRect);
```

Annotation zoom controls are commands, not decoration. Both magnifier icons must be semantic buttons with accessible names, the range input must update the same zoom state, and `Ctrl/Command + wheel` over the scroll area may use the same clamped update path. The supported stage scale is `25%..400%`; `100%` means fit the available canvas width.

## Scenario: Extended Annotation Workspace And Metric Axes

### 1. Scope / Trigger

- Trigger: adding an annotation geometry, SDXL image field, or training metric series.
- Reason: geometry editing, persisted document shape, export compatibility and chart scaling must stay aligned.

### 2. Signatures

- `AnnotationGeometry = rectangle | polygon | keypoint | polyline | ellipse | skeleton`.
- `MetricSeries = { name, color, values, axis?: 'left' | 'right', format?: 'score' | 'number' }`.
- `AnnotationDocument` carries `annotations`, `captions` and `imageAttributes` in one revision.

### 3. Contracts

- Every vector object uses normalized `0..100` coordinates, is selectable and movable, and exposes type-appropriate control points. A locked object remains selectable but cannot move, resize or be deleted.
- SDXL image annotation is a separate right-panel view with inclusion, one primary Caption, language, comma-separated tags and an optional normalized crop preview.
- Score series use the left `0..1` scale. Loss series use an independently calculated right scale. The legend shows the latest exact value; pointer hover/touch shows Epoch and all visible values.
- Long tool lists scroll vertically and cannot resize the canvas grid.

### 4. Validation & Error Matrix

- `includeInSdxl=true` without a non-empty primary Caption -> block save and show the image filename.
- Geometry move/resize outside the bitmap -> clamp the complete shape to `0..100`.
- A series has no value at the hovered Epoch -> render `--`, never call numeric formatting on `undefined`.
- Review/submitted document -> all drawing, property, lock and SDXL inputs are read-only.

### 5. Good/Base/Bad Cases

- Good: draw an ellipse, resize it, lock it, add a Caption, switch image, then save both drafts with their independent revisions.
- Base: a detection-only image leaves SDXL inclusion off and saves geometry normally.
- Bad: encode a line as a thin rectangle, auto-build SDXL prompts from detection classes, or scale Loss against the score axis.

### 6. Tests Required

- Component tests create a line and an SDXL Caption, then assert the exact API payload.
- Pure geometry tests cover reverse drag, bounds and ellipse movement.
- Metric tests assert both axes, exact legend values and series toggling.
- Browser screenshots cover desktop and narrow viewport with no canvas/control overlap.

### 7. Wrong vs Correct

#### Wrong

```tsx
<MetricChart values={lossAndMiou} min={0} max={1} />
```

#### Correct

```tsx
<MetricChart series={[
  { name: 'mIoU', values: scores, axis: 'left', format: 'score' },
  { name: 'Loss', values: losses, axis: 'right', format: 'number' },
]} />
```
