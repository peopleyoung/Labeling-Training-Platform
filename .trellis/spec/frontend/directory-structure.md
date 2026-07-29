# Directory Structure

## Directory Layout

```
src/
├── components/     # Shared visual units and application frame
├── context/        # Cross-route client state and commands
├── data/           # Typed, deterministic prototype fixtures
├── pages/          # Route-owned workflow screens
├── test/           # Shared Vitest setup
├── types.ts        # Domain entities shared by data, state, and pages
└── utils/          # Pure, unit-tested calculations and formatting
e2e/                # Playwright workflows; never imported by Vitest
```

## Module Rules

- Pages own route layout and local interaction state. They consume shared components and `useApp`, but do not duplicate seed data.
- Visual units used by multiple routes belong in `components/`. Keep route-only markup with its page until it has a second consumer.
- Fixture entities and lookup tables live in `data/mockData.ts`; public shapes live in `types.ts`.
- Extract calculations to `utils/` only when their behavior is independently testable.

## Naming

- React component and page files use PascalCase: `TrainingWizardPage.tsx`.
- Context modules use PascalCase and export a `use*` accessor: `AppContext.tsx`, `useApp`.
- Pure helper files use lower camel case with an adjacent test: `annotation.ts`, `annotation.test.ts`.

`pages/AnnotationPage.tsx` owns SVG tool state; `utils/annotation.ts` owns normalized point and rectangle calculations.
