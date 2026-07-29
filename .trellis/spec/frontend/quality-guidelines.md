# Quality Guidelines

## Required Commands

```bash
npm run typecheck
npm run test
npm run build
npm run test:e2e
```

Vitest only collects `src/**/*.test.{ts,tsx}`. Playwright owns `e2e/**/*.spec.ts` via `playwright.config.ts`; do not allow Vitest to import Playwright declarations.

## Testing Requirements

- Pure calculations need adjacent unit tests. `utils/annotation.test.ts` covers normalization and reverse dragging.
- Route behavior needs React Testing Library coverage for navigation and form state.
- End-to-end coverage must exercise export, annotation, training configuration, conversion, and narrow-screen navigation.
- Visual changes require screenshot review at desktop and mobile widths; check canvas pixels are nonblank and controls do not overlap.

## Forbidden Patterns

- Do not leave `console.log`, `@ts-ignore`, or broad `any` casts in application code.
- Do not call Playwright's `test()` from a file Vitest collects.
- Do not duplicate status labels or format descriptions in route files; import canonical maps from `data/mockData.ts` or `utils/format.ts`.
