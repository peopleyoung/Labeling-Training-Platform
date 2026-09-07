# Quality Guidelines

> Code quality standards for backend development.

---

## Overview

<!--
Document your project's quality standards here.

Questions to answer:
- What patterns are forbidden?
- What linting rules do you enforce?
- What are your testing requirements?
- What code review standards apply?
-->

(To be filled by the team)

---

## Forbidden Patterns

<!-- Patterns that should never be used and why -->

(To be filled by the team)

---

## Required Patterns

<!-- Patterns that must always be used -->

- Training Workers must resolve official pretrained weights through the shared `FORGE_MODEL_CACHE`. A missing Ultralytics weight may be downloaded on demand only when `FORGE_PRETRAINED_OFFLINE` is not enabled; cache misses in offline mode and failed downloads must produce an explicit task failure. Never silently switch a requested pretrained job to scratch initialization.

---

## Testing Requirements

<!-- What level of testing is expected -->

- Training changes must cover the model-family/data-format contract, cache-hit behavior, offline cache misses, and at least one real or isolated Worker training path for each affected model family.

---

## Code Review Checklist

<!-- What reviewers should check -->

(To be filled by the team)
