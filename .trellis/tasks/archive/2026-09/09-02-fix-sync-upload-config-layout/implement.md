# Implementation Plan

## Sequence

1. Add focused regression coverage for the failing statistics query and the
   dataset form/media boundary. Verify each test fails for the current bug or
   captures the currently missing contract.
2. Fix PostgreSQL statistics scoping through dataset joins. Verify the API
   endpoint returns 200 against the running PostgreSQL deployment.
3. Add shared media metadata inference and client-side dataset payload
   validation. Verify valid image/archive/video uploads and invalid form values
   through the API and browser path.
4. Replace the two preprocessing checkbox field layouts with the normal field
   structure and set matching stable dimensions in CSS. Verify desktop/mobile
   bounding boxes with a browser smoke script.
5. Run the full quality gate and rebuild/redeploy the web and API services.

## Validation Commands

- `npm run typecheck`
- `npm run typecheck:server`
- `npm test -- --run`
- `npm run build`
- Browser smoke against `http://127.0.0.1:5173` for refresh, create-task
  validation, and preprocessing field dimensions.
- `curl` against authenticated `/api/v1/annotation-statistics` and the health
  endpoint, with credentials/tokens omitted from captured output.

## Rollback Points

- Revert only the statistics query if the API SQL compatibility probe fails.
- Revert only media normalization if a valid upload fixture changes source
  type unexpectedly.
- Revert the checkbox markup/CSS independently if measured fields differ on a
  target viewport.
