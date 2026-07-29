# Type Safety

## Type Organization

Shared domain entities live in `src/types.ts`. Fixture modules and context commands import these types rather than declaring structural copies.

```ts
export type ConversionFormat = 'ONNX' | 'TensorRT' | 'TorchScript' | 'OpenVINO';

export interface TrainingDraft {
  type: TrainingType;
  datasetId: string;
  model: string;
  epochs: number;
  gpu: string;
}
```

Use `as const` lookup maps when UI labels/configuration are keyed by a union.

```ts
export const formatDescriptions = {
  ONNX: { target: '通用 CPU / GPU' },
  TensorRT: { target: 'NVIDIA Orin / Ampere+' },
  TorchScript: { target: 'PyTorch Runtime' },
  OpenVINO: { target: 'Intel Core / Xeon' },
} as const;
```

## Validation And Prohibitions

Fixtures are trusted typed local data. Add runtime schema validation at a future API boundary rather than scattering casts through pages.

- Do not use `any`, `@ts-ignore`, or non-null assertions when a route parameter or finder can be narrowed safely.
- Do not store annotation coordinates as raw pixels; use normalized values from `utils/annotation.ts`.
