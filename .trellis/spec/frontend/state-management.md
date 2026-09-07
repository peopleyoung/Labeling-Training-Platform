# State Management

> How state is managed in this project.

---

## Overview

<!--
Document your project's state management conventions here.

Questions to answer:
- What state management solution do you use?
- How is local vs global state decided?
- How do you handle server state?
- What are the patterns for derived state?
-->

(To be filled by the team)

## Server State Synchronization

- `AppContext` owns the canonical `datasets` list and exposes `refreshDatasets()` for commands and page-level polling.
- `DatasetsPage` polls processing runs, source assets, and annotation Jobs every three seconds while the data center is visible.
- Polling must use stable dataset identity dependencies. Updating the dataset array must not recreate a polling loop when the visible IDs are unchanged.
- A successful submit, review, or processing start may trigger a refresh, but a failed background refresh must not turn the successful primary command into an error.
- Job status and dataset aggregate status are different server values. Render task-segment status from the Job list and dataset status from the dataset response.

## Common Mistakes

- Do not use the dataset-wide `claim-next` endpoint when the user selected a specific review Job.
- Do not treat a completed processing run as sufficient UI state; reload the dataset and source assets as well.
- Do not infer annotation geometry from a default square canvas when image dimensions are available from the upload contract.
- If an older image has no stored dimensions, use the preview's natural dimensions, remap the current canvas draft from the previous canvas size, and keep the SVG viewBox aligned with the image.
- Annotation labels and cursor handles are screen-readable overlays: calculate their SVG-unit size from the rendered canvas width and current zoom instead of using a fixed user-unit size.

---

## State Categories

<!-- Local state, global state, server state, URL state -->

(To be filled by the team)

---

## When to Use Global State

<!-- Criteria for promoting state to global -->

(To be filled by the team)

---

## Server State

<!-- How server data is cached and synchronized -->

(To be filled by the team)

---

## Common Mistakes

<!-- State management mistakes your team has made -->

(To be filled by the team)
