# Error Handling

## Overview

The API uses `HttpError` for expected client-facing failures and `RepositoryConflictError` for optimistic-lock conflicts. All HTTP errors returned to the frontend must use the same machine-readable envelope so UI code can branch on `error.code` instead of parsing Chinese text.

## Scenario: Machine-Readable API Errors

### 1. Scope / Trigger

- Trigger: any Fastify route, repository method, worker callback, or frontend client code that creates, maps, or displays an API error.
- Reason: the product UI needs actionable Chinese feedback, but the programmatic contract is the stable `code` and optional `fields` object.

### 2. Signatures

- `new HttpError(statusCode, code, message, fields?)`
- `RepositoryConflictError` maps to `409 ANNOTATION_REVISION_CONFLICT`
- API response envelope:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "请求参数不符合要求",
    "fields": { "epochs": "必须大于 0" },
    "requestId": "req-..."
  }
}
```

- Frontend client error:

```ts
new ApiClientError(code, message, fields?)
```

### 3. Contracts

- `error.code` is stable and ASCII. It is the field UI and tests should assert.
- `error.message` is user-facing Chinese copy. It may change without changing the programmatic meaning.
- `error.fields` is present only for validation failures and maps field path to a Chinese validation message.
- `error.requestId` is always included by the Fastify error handler.
- Non-login routes require a valid Bearer token. Expired, missing, or role-mismatched tokens return `UNAUTHORIZED`.

### 4. Validation & Error Matrix

- Zod parse failure -> `400 VALIDATION_ERROR`, with `fields`.
- Missing authenticated user/token -> `401 UNAUTHORIZED`.
- Bad username/password -> `401 INVALID_CREDENTIALS`.
- Role mismatch -> `403 FORBIDDEN`.
- Missing dataset/model/job/conversion -> `404 *_NOT_FOUND`.
- Annotation stale revision -> `409 ANNOTATION_REVISION_CONFLICT`.
- Annotation final state enables SDXL without a primary Caption -> `409 SDXL_CAPTION_REQUIRED`.
- Model/dataset incompatibility -> `400 UNSUPPORTED_MODEL` or `400 DATASET_TYPE_MISMATCH`.
- Unsupported conversion precision/target -> `400 UNSUPPORTED_CONVERSION_CONFIG`.
- Unknown export/artifact -> `404 EXPORT_NOT_FOUND` or `404 ARTIFACT_NOT_FOUND`.
- Registered artifact without locally readable content -> `404 ARTIFACT_CONTENT_NOT_FOUND`.
- Artifact key that resolves outside `FORGE_ARTIFACT_ROOT` -> `400 INVALID_ARTIFACT_PATH`.
- GPU training or conversion requested while `FORGE_GPU_ENABLED=false` -> `503 GPU_UNAVAILABLE`.
- Unexpected exception -> `500 INTERNAL_ERROR` and server log entry.

### 5. Good/Base/Bad Cases

- Good: route validates with a shared Zod schema, throws `HttpError`, and the global handler produces the envelope.
- Base: repository throws `RepositoryConflictError`; API maps it centrally to a conflict code.
- Bad: returning `{ message: "..." }`, throwing raw strings, or making frontend code match Chinese text.

### 6. Tests Required

- API tests must assert status code and `error.code` for at least validation, conflict, forbidden, and compatibility failures.
- Frontend command handlers must catch `ApiClientError` and call `notify()` with the message.
- E2E flows should exercise at least one create path that would surface API failure as a toast when the backend rejects it.

### 7. Wrong vs Correct

#### Wrong

```ts
if (!dataset) return reply.status(404).send({ message: '数据集不存在' });
```

#### Correct

```ts
if (!dataset) throw new HttpError(404, 'DATASET_NOT_FOUND', '数据集不存在');
```

## Error Types

- `HttpError`: expected API failures with status, code, message, and optional field map.
- `RepositoryConflictError`: optimistic-lock conflict for annotation documents.
- `ApiClientError`: frontend wrapper around the API error envelope.

## Error Handling Patterns

- Parse request bodies through `parseBody(schema, request.body)`.
- Throw errors from routes and let `app.setErrorHandler()` serialize them.
- Worker failures must mark the originating task row as `failed` before rethrowing to BullMQ.
- Export worker failures must persist the Chinese `error_message` on `export_tasks`; the task detail route exposes it as `ExportTask.errorMessage`.
- Log only unexpected server exceptions; expected client errors should not be logged as server faults.

## API Error Responses

Every error response must be:

```ts
{
  error: {
    code: string;
    message: string;
    fields?: Record<string, string>;
    requestId: string;
  };
}
```

## Common Mistakes

- Asserting Chinese messages in tests instead of stable error codes.
- Handling validation in both UI and API with divergent rules. UI may guide users, but API Zod schemas own enforcement.
- Swallowing worker errors after setting a task failed; BullMQ must still see the thrown error for retry/failure accounting.
