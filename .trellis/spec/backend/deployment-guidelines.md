# Deployment Guidelines

## Scenario: Single-Host Compose Public Address And Artifact Contract

### 1. Scope / Trigger

- Trigger: changing `docker-compose.yml`, `.env.example`, Docker build arguments, exposed ports, runtime secrets, persistent volumes, or operational deployment docs.
- Reason: the Web API address crosses the image-build/browser boundary, while CORS and artifact paths cross the API/worker/container boundary. A localhost default that reaches the deployment host is not necessarily reachable from a user's browser.

### 2. Signatures

- `VITE_API_BASE_URL` is a `docker compose` build arg for `docker/web.Dockerfile`.
- `CORS_ORIGIN` is the `api` container runtime environment variable.
- `FORGE_ARTIFACT_ROOT=/data/artifacts` is shared by `worker` (read/write) and `api` (read-only through `forge-worker-data`).
- `BOOTSTRAP_ADMIN_USERNAME`, `BOOTSTRAP_ADMIN_PASSWORD`, and `BOOTSTRAP_ADMIN_DISPLAY_NAME` define the only initial user; the password must contain at least 12 characters.
- Public bindings are `${WEB_BIND}:${WEB_PORT}:5173` and `${API_BIND}:${API_PUBLIC_PORT}:4000`.
- The MinIO console binding is `${MINIO_CONSOLE_BIND}:${MINIO_CONSOLE_PORT}:9001` and defaults to `127.0.0.1:9001`.

### 3. Contracts

- Browser deployments must set both `VITE_API_BASE_URL` and `CORS_ORIGIN` to the actual user-visible scheme, host, and port. `VITE_API_BASE_URL` must end in `/api/v1`.
- Rebuild `web` after changing `VITE_API_BASE_URL`; recreate `api` after changing `CORS_ORIGIN`.
- The API startup command is `npm run db:migrate && npm run db:seed && npm run start:api`. Migrations are forward-only and are recorded in `schema_migrations`.
- `db:seed` creates only the default workspace and bootstrap administrator. It must not insert datasets, annotations, jobs, models, conversions, artifacts, or secondary accounts.
- Bootstrap upsert does not overwrite an existing password hash. Changing `.env` after first creation is not a password reset mechanism.
- PostgreSQL, Redis, MinIO, and `forge-worker-data` are persistent Compose volumes. Do not use `docker compose down -v` for a routine restart.
- `.env` and `backups/` are local secrets/operational data and must stay ignored by Git.

### 4. Validation & Error Matrix

- Missing `JWT_SECRET` when Compose resolves the API service -> configuration failure before container start.
- Missing `BOOTSTRAP_ADMIN_PASSWORD` in Compose -> configuration failure before container start.
- Bootstrap password shorter than 12 characters -> API configuration error before seeding.
- Browser requests the host-local `localhost:4000` after remote deployment -> incorrect `VITE_API_BASE_URL`; rebuild Web with the server IP/domain.
- Browser CORS rejection -> incorrect `CORS_ORIGIN`; recreate API with the exact Web origin.
- Artifact metadata exists but download returns `ARTIFACT_CONTENT_NOT_FOUND` -> inspect `forge-worker-data`, `/data/artifacts`, and worker logs.
- Worker cannot see a GPU -> `docker run --rm --gpus all ... nvidia-smi` must pass before composing the GPU service.

### 5. Good/Base/Bad Cases

- Good: an intranet host `172.16.66.79` uses `CORS_ORIGIN=http://172.16.66.79:5173` and `VITE_API_BASE_URL=http://172.16.66.79:4000/api/v1` before `docker compose build web`.
- Base: a local developer leaves the documented localhost defaults and starts the stack with `docker compose up -d --build`.
- Bad: publishing the MinIO console to all interfaces, committing `.env`, hardcoding an initial password, or inserting demonstration business records during production seed.

### 6. Tests Required

- Run `JWT_SECRET=test-secret BOOTSTRAP_ADMIN_PASSWORD=test-admin-password docker compose config --quiet` for default values.
- Verify a fresh seed produces one workspace, one admin user, and zero rows in all business record tables.
- Run the same Compose config command with a non-local `CORS_ORIGIN` and `VITE_API_BASE_URL`; assert the resolved API environment and Web build argument contain those values and MinIO remains bound to `127.0.0.1` by default.
- Deployment docs must state migration verification, Worker GPU verification, backup scope for PostgreSQL/MinIO/worker artifacts, and the current local-volume versus S3 artifact boundary.

### 7. Wrong vs Correct

#### Wrong

```yaml
web:
  build:
    args:
      VITE_API_BASE_URL: http://localhost:4000/api/v1
```

#### Correct

```yaml
web:
  build:
    args:
      VITE_API_BASE_URL: ${VITE_API_BASE_URL:-http://localhost:4000/api/v1}
```

## Common Mistakes

- Treating `VITE_API_BASE_URL` as a runtime environment variable after the Web image is built.
- Backing up MinIO but omitting `forge-worker-data`, even though the current artifact delivery path reads that volume.
- Applying a schema change by editing an applied migration instead of adding the next numbered SQL file.
- Treating a bootstrap password environment change as a password reset for an existing database user.
- Using `kind:taskId` as a BullMQ custom job id. BullMQ rejects `:` only at real queue insertion, so in-memory API tests can pass while deployed task creation returns `500`.

## Bootstrap Wrong vs Correct

### Wrong

```ts
await insertUsers([admin, engineer, annotator]);
await insertDatasets(sampleDatasets);
```

### Correct

```ts
await seedDatabase(databaseUrl, config.bootstrapAdmin);
// Creates the workspace and administrator only; business tables remain empty.
```

## Scenario: Browser CORS Method Contract

### 1. Scope / Trigger

- Trigger: adding or changing any browser-called API route, HTTP method, custom request header, public Web origin, or CORS plugin configuration.
- Reason: a successful `OPTIONS 204` is insufficient when `Access-Control-Allow-Methods` omits the requested method; the browser then blocks the real request and surfaces only `Failed to fetch`.

### 2. Signatures

- `buildApi()` registers CORS with `methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']`.
- Binary uploads use `PUT` plus `authorization`, `content-type`, `x-file-name`, `x-file-mime-type`, and image/model metadata headers.
- Dataset deletion uses `DELETE`; class/model state updates use `PATCH`.

### 3. Contracts

- Every HTTP method used by `ApiClient` must appear in `Access-Control-Allow-Methods` for the configured `CORS_ORIGIN`.
- Custom request headers must be echoed by `Access-Control-Allow-Headers`; the current Fastify CORS reflection behavior owns this unless an explicit allow-list replaces it.
- Frontend fetch rejections must become `ApiClientError('NETWORK_ERROR', <Chinese actionable message>)`; page components must not display the browser's raw `Failed to fetch` string.
- A create-then-upload flow can persist the dataset before upload starts. Browser preflight tests are required so an infrastructure regression cannot leave repeated zero-image datasets.

### 4. Validation & Error Matrix

- Preflight `PUT` upload with the configured origin and custom headers -> `204`, allow-origin matches, allow-methods contains `PUT`, allow-headers contains upload headers.
- Preflight `DELETE` dataset -> `204` and allow-methods contains `DELETE`.
- Preflight `PATCH` class/model update -> `204` and allow-methods contains `PATCH`.
- Origin different from `CORS_ORIGIN` -> browser blocks the request; deployment must correct the origin rather than enable unrestricted CORS.
- Network-level fetch rejection -> UI shows the normalized Chinese `NETWORK_ERROR` message.

### 5. Good/Base/Bad Cases

- Good: a deployed browser creates a temporary dataset, uploads a valid image through `PUT`, previews it, deletes the dataset through `DELETE`, and confirms both database and artifact cleanup.
- Base: API injection tests validate direct route behavior and dedicated preflight tests validate the browser boundary.
- Bad: checking only that `OPTIONS` returns `204`, or relying on the CORS library's default `GET,HEAD,POST` methods while the product uses `PUT/PATCH/DELETE`.

### 6. Tests Required

- API tests must preflight `PUT`, `PATCH`, and `DELETE` with `Origin` and `Access-Control-Request-Method`, then assert response headers, not only status.
- Deployment smoke must exercise upload and deletion from a browser origin and verify the actual non-OPTIONS requests reached API logs.
- The upload/delete smoke must use a uniquely named temporary dataset and remove its database rows and artifact files after verification.

### 7. Wrong vs Correct

#### Wrong

```ts
await app.register(cors, { origin: config.corsOrigin, credentials: true });
// Defaults allow only GET, HEAD, and POST.
```

#### Correct

```ts
await app.register(cors, {
  origin: config.corsOrigin,
  credentials: true,
  methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
});
```

## Scenario: CPU-Only Compose And Optional GPU Worker

### 1. Scope / Trigger

- Trigger: deploying on a host without NVIDIA hardware, or enabling/disabling CPU/GPU task execution independently.
- Reason: a CPU-only installation must support real YOLO training and CPU-safe FP32 conversion without declaring an NVIDIA device.

### 2. Signatures

- `FORGE_GPU_ENABLED=false|true` controls CUDA-backed training and conversion admission.
- `FORGE_CPU_TRAINING_ENABLED=false|true` controls CPU training admission and defaults to `true`.
- `FORGE_CPU_ONNX_ENABLED=false|true` controls CPU FP32 ONNX conversion admission and defaults to `true`.
- `GET /api/v1/capabilities` returns `{ gpuEnabled, cpuTrainingEnabled, cpuOnnxEnabled, cpuConversionFormats }`; CPU formats are `ONNX`, `TorchScript`, and `OpenVINO` when conversion is enabled.
- `queueNameFor('export') -> 'forge-export'`; `queueNameFor('training' | 'conversion', 'cpu') -> 'forge-cpu'`; GPU work routes to `forge-gpu`.
- `queueJobId(kind, taskId) -> '<kind>-<taskId>'`; BullMQ custom job ids must not contain `:`.
- `export-worker` consumes `FORGE_QUEUE_NAME=forge-export`; `cpu-worker` consumes `FORGE_QUEUE_NAME=forge-cpu` with `FORGE_EXECUTION_DEVICE=cpu`; the optional `worker` service consumes `forge-gpu` with `FORGE_EXECUTION_DEVICE=gpu`.

### 3. Contracts

- `docker compose up -d --build` is CPU-only by default: it starts both `export-worker` and `cpu-worker`, but does not build or start the CUDA Worker.
- GPU deployment requires `FORGE_GPU_ENABLED=true` and `docker compose --profile gpu up -d --build`.
- When GPU is disabled, API routes enabled training jobs to `forge-cpu`, persists `gpu: 'CPU'` and `mixedPrecision: false`, and routes FP32 ONNX/TorchScript/OpenVINO conversion to `forge-cpu`.
- CPU conversion must resolve a registered source-model artifact before enqueue. YOLO training artifacts retain model-family lineage; generic existing ONNX sources are validated and copied, and loadable TorchScript/JIT sources may be exported through `torch.onnx.export` and checked with ONNX.
- Conversion request validation must accept generated training versions (`train-<UUID>`); `modelVersion` allows up to 80 characters and must stay aligned with persisted worker-generated versions.
- TensorRT remains a GPU-worker operation. Every CPU conversion format rejects non-FP32 precision instead of silently changing the request.
- Queue producers must build custom ids through `queueJobId()`. Do not interpolate queue ids inline; the memory queue does not validate BullMQ identifier restrictions.
- Worker output directories and registered artifact keys must describe the same physical file. Build categorized directories through `artifactTaskDirectory()` and derive the persisted key from the final file path through `artifactObjectKey()`.
- UI reads all `/capabilities` fields through `AppContext`, exposes the returned CPU formats, and disables TensorRT without GPU; API admission remains authoritative.

### 4. Validation & Error Matrix

- `gpuEnabled=false`, `cpuTrainingEnabled=true` plus training POST -> `202`, normalized CPU/FP32 job row and `forge-cpu` item.
- `gpuEnabled=false`, `cpuOnnxEnabled=true`, registered source artifact, ONNX/FP32 POST -> `202` and `forge-cpu` item.
- CPU-only TorchScript or OpenVINO FP32 POST -> `202` and `forge-cpu` item.
- CPU-only TensorRT POST -> `503 CPU_CONVERSION_UNAVAILABLE`, no job row.
- CPU-only conversion with FP16 or INT8 -> `400 CPU_CONVERSION_PRECISION_UNSUPPORTED`, no job row.
- Missing source model -> `404 SOURCE_MODEL_NOT_FOUND`; model without artifact -> `409 SOURCE_MODEL_ARTIFACT_MISSING`.
- Both GPU and CPU training disabled plus training POST -> `503 TRAINING_WORKER_UNAVAILABLE`.
- `FORGE_GPU_ENABLED=false` plus export POST -> `202`, export queue item consumed by `export-worker`.
- GPU profile without a functioning NVIDIA runtime -> Worker deployment failure; API must remain disabled until the operator fixes the host and enables the flag.
- Invalid boolean capability value -> API configuration error before startup.

### 5. Good/Base/Bad Cases

- Good: CPU host starts the default Compose stack, completes a real YOLO training task, and converts its registered `best.pt` to validated FP32 ONNX, TorchScript, or OpenVINO.
- Base: GPU host sets `FORGE_GPU_ENABLED=true` and includes the `gpu` profile.
- Bad: routing a CPU task to `forge-gpu`, accepting a GPU-only conversion on a CPU host, or creating an ONNX job without a resolvable source artifact.

### 6. Tests Required

- Parse the default Compose configuration and the GPU-profile configuration.
- API tests assert the complete capability payload, CPU training normalization and enqueue, all CPU-safe conversion enqueues, TensorRT rejection, and source-artifact errors.
- Playwright starts an isolated server and asserts CPU Worker status, CPU training messaging, enabled CPU formats, and disabled TensorRT controls.
- Queue unit tests assert generated custom job ids contain no colon. Deployment smoke must enqueue and complete at least one Redis-backed export task; memory queue tests alone are insufficient.
- Deployment smoke must also complete a Redis-backed CPU training task and FP32 ONNX conversion, then validate the downloaded ONNX graph.
- Artifact path tests assert `resolve(artifactRoot, objectKey)` equals the file written by the Worker, including files discovered in nested output directories.

### 7. Wrong vs Correct

#### Wrong

```yaml
worker:
  deploy:
    resources:
      reservations:
        devices: [{ driver: nvidia, count: 2, capabilities: [gpu] }]
```

#### Correct

```yaml
export-worker:
  environment:
    FORGE_QUEUE_NAME: forge-export
cpu-worker:
  environment:
    FORGE_QUEUE_NAME: forge-cpu
    FORGE_EXECUTION_DEVICE: cpu
worker:
  profiles: [gpu]
  environment:
    FORGE_QUEUE_NAME: forge-gpu
    FORGE_EXECUTION_DEVICE: gpu
```

## Scenario: Real YOLO Training And Conversion

### 1. Scope / Trigger

- Trigger: executing a detection training job whose model variant belongs to YOLOv5 or YOLOv8, or converting the resulting model version.
- Reason: task persistence and placeholder files do not constitute model training or conversion. A completed task must point to a framework-generated, validated deployment artifact.

### 2. Signatures

- `prepareYoloDataset({ artifactRoot, outputDir, classes, images }) -> { yamlPath, classes, counts, imageCount }`.
- YOLOv5u and YOLOv8 training run the pinned `yolo detect train` CLI. Stable product ids such as `yolov5n` resolve to official weights such as `yolov5nu.pt`.
- `FORGE_MODEL_CACHE=/data/model-cache` persists pretrained weights in the shared Worker volume.
- `TrainingDraft.weightSource` is `pretrained | scratch`; `scratch` resolves to the pinned Ultralytics YAML and must not require a weight download.
- Conversion runner receives `modelFamily: 'yolov5' | 'yolov8' | 'unknown'` from training/model lineage.
- Deterministic conversion filenames are `converted.onnx`, `converted.torchscript.pt`, `converted-openvino.zip`, and `converted.engine`.

### 3. Contracts

- Dataset preparation reads persisted images and non-empty annotation documents. Rectangle annotations become normalized YOLO boxes; polygons become their bounding boxes; keypoints and labels absent from dataset classes are not detection targets.
- The train split must contain at least one usable target. Validation uses `images/val` when present and falls back to `images/train` only when the dataset has no validation images.
- Worker removes stale task output before execution, registers `weights/best.pt` preferentially, reads the final real mAP@50 from `results.csv`, and creates a model version whose `source_job` preserves lineage.
- Both YOLOv5u and YOLOv8 conversion use the pinned `Ultralytics.YOLO.export`. ONNX is checked with `onnx.checker`; OpenVINO is accepted only with both XML and BIN and is delivered as a ZIP; every artifact must be a non-empty file.
- The controlled training source must round-trip from the shared contract through API persistence and UI details to the Worker command. The UI must not show unimplemented model-repository choices.
- Scratch training passes `pretrained=False` and disables plots so model initialization does not trigger checkpoint or font downloads. Conversion inherits `imageSize` from source-job lineage when available.
- TensorRT conversion is rejected on CPU. Its engine must be built in the CUDA Worker for the target-compatible NVIDIA architecture.
- TensorRT and OpenVINO expose only FP32/FP16. INT8 must remain rejected until a calibration-dataset contract and post-export precision validation are implemented.
- No execution path may write a JSON marker with a model extension and report the task completed.

### 4. Validation & Error Matrix

- Missing or empty train targets -> training task `failed` with `训练分片没有包含有效目标框的已标注图片`.
- Dataset image path outside artifact root -> training task `failed`; never read the escaped path.
- Exporter command non-zero or expected file missing/empty -> conversion task `failed` and no artifact row.
- OpenVINO XML without BIN -> conversion task `failed`.
- Unknown plain `.pt` without YOLO lineage -> conversion task `failed` with a model-family error; do not guess an architecture.
- First training without cached weights and without network/internal model source -> task `failed` with upstream download output retained in `error_message`.
- Offline training with `weightSource=scratch` -> model YAML initializes locally and training proceeds without a pretrained checkpoint download.

### 5. Good/Base/Bad Cases

- Good: two annotated train images produce paired `images/train` and `labels/train` files, one epoch creates `run/weights/best.pt`, and ONNX export passes `onnx.checker`.
- Base: validation split is absent, so `dataset.yaml` explicitly points `val` to `images/train` and the framework still performs validation.
- Bad: pass a nonexistent `/data/datasets/<task>/dataset.yaml`, register the first `.json` in an output directory, or save `torch.nn.Identity()` as a claimed YOLO checkpoint.

### 6. Tests Required

- Dataset builder unit tests verify normalized coordinates, exact image/label pairing, empty annotation exclusion, path safety, and missing-train rejection.
- Python smoke validates both YOLO training command families and every conversion command without launching heavy training.
- CPU Worker image smoke imports Torch/Torchvision/Ultralytics/ONNX/OpenVINO and proves the `yolo` CLI is available.
- End-to-end Worker smoke uses a temporary annotated dataset and one lightweight YOLO epoch, asserts a non-empty `best.pt`, then creates and validates at least ONNX. Temporary rows and artifacts are removed afterward.
- GPU release validation separately builds one TensorRT engine on the declared target GPU and records the CUDA/TensorRT environment.

### 7. Wrong vs Correct

#### Wrong

```py
torch.jit.script(torch.nn.Identity()).save("model.pt")
```

#### Correct

```text
dataset images + annotation_documents
  -> YOLO images/labels + dataset.yaml
  -> upstream YOLO train
  -> weights/best.pt
  -> upstream family exporter
  -> validated deployment artifact
```

## Scenario: Structured Vision And SDXL Training

### 1. Scope / Trigger

- Trigger: adding or changing segmentation, keypoint, SDXL training, their model catalog entries, or non-YOLO conversion behavior.
- Reason: a queued lifecycle, marker file, ignored weight source, or model-shaped filename is not proof of training. Persisted annotations must reach a real optimization step and the registered artifact must be loadable.

### 2. Signatures

- `prepareStructuredTrainingDataset({ artifactRoot, outputDir, task, classes, images }) -> { manifestPath, classes, keypointCount, counts, imageCount }` writes version `1` JSON for `segmentation | keypoint | sdxl`.
- Segmentation modules: `segformer-b0..b5`, `unet`, `deeplabv3plus-resnet50|resnet101`.
- Keypoint modules: `hrnet-w32|w48`, `higherhrnet-w32|w48` using timm ImageNet HRNet backbones and in-repository heatmap heads.
- `FORGE_SDXL_BASE_MODEL` points to a complete local Diffusers SDXL Base directory; default `/data/model-cache/stable-diffusion-xl-base-1.0`.
- `FORGE_MODEL_CACHE` defaults to `/data/model-cache`; framework caches are rooted below it through `TORCH_HOME`, `HF_HOME`, and `HF_HUB_CACHE`.
- `FORGE_PRETRAINED_OFFLINE=true|false` controls whether training may contact a model source after checking the persistent cache. `HF_ENDPOINT` may point Transformers downloads at an approved internal Hugging Face-compatible mirror.
- Successful structured vision training writes `model.torchscript.pt`, `metrics.json`, and `manifest.json`; SDXL writes `pytorch_lora_weights.safetensors` plus metrics/manifest.
- `PYTHONPATH=worker python3 -m forge_worker.prefetch_models [models...]` populates and validates all supported pretrained backbones.
- `PYTHONPATH=worker python3 -m forge_worker.acceptance_smoke [--pretrained] [--all-cpu-formats] [models...]` runs isolated real-training acceptance without business rows.

### 3. Contracts

- Segmentation rasterizes valid persisted rectangle/polygon annotations into background-plus-class index masks. Keypoint training maps positive one-based `geometry.index` values to Gaussian heatmap channels. Both require a usable train split and fall back to train for validation only when validation is absent.
- SegFormer loads NVIDIA MIT B0-B5 encoder weights through Transformers. A local `<cache>/pretrained/segformer-<variant>.pth` checkpoint or complete Transformers directory takes precedence over the remote model id.
- U-Net uses a TorchVision ResNet34 encoder; DeepLabV3+ uses a TorchVision ResNet50/101 encoder and ASPP decoder. `pretrained` loads the matching ImageNet weights, while `scratch` constructs the same architecture without a download.
- HRNet/HigherHRNet use timm `hrnet_w32.ms_in1k` or `hrnet_w48.ms_in1k` backbones. The heatmap head fuses reduction 4/8/16/32 features; using only the first shallow feature is forbidden because it produces an apparently valid but semantically incomplete export. HigherHRNet adds its refinement stage after fusion.
- `TrainingDraft.weightSource` accepts `pretrained | scratch` for segmentation and keypoint models. API persistence, queue payload, runner environment, progress events, artifact manifest, and UI details must retain the selected value; never accept `pretrained` and initialize randomly.
- Pretrained source resolution must be deterministic and cache-first. With offline mode enabled, a missing checkpoint fails the task with an actionable cache path/source message and never falls back to scratch.
- CPU supports real FP32 segmentation/keypoint training and ONNX/TorchScript/OpenVINO conversion. TensorRT requires the GPU Worker.
- SDXL accepts only a preseeded local Base model and CUDA Worker. LoRA and DreamBooth LoRA optimize UNet attention adapters and save Diffusers-compatible SafeTensors. ControlNet remains unavailable until a paired conditioning-image/target-image data contract exists.
- SDXL input format is `IMAGE_FOLDER`: the package contains selected images plus `metadata.jsonl` rows `{ file_name, text, split, tags, crop }`. The TypeScript adapter must read this standard package back into the versioned structured manifest before launching Python.
- `SdxlImageDataset` uses the reviewed `prompt`, applies the optional normalized crop before resize, and rejects empty prompts. Geometry labels are not an SDXL text source.
- SDXL conversion loads the same Base, fuses the registered LoRA, and exports only the UNet component to ONNX/TorchScript/OpenVINO/TensorRT. The artifact must not be described as a complete SDXL Pipeline.
- Every successful training manifest contains `realTraining: true`; every conversion manifest contains `realConversion: true`, SHA-256, family, format, and source. These flags supplement, but never replace, load/check validation.

### 4. Validation & Error Matrix

- Supported segmentation/keypoint with `weightSource=pretrained` and cached source -> accepted and queued on the selected CPU/GPU Worker.
- Unknown `weightSource` -> `400 VALIDATION_ERROR`, no queue row.
- Offline pretrained source missing or incompatible -> executor failure with source/cache guidance, task `failed`, no model artifact registration; do not fall back to scratch.
- Online pretrained source unavailable -> executor failure includes the upstream source and recommends prefetching; no model artifact registration.
- CPU SDXL training -> `503 SDXL_GPU_REQUIRED`, no queue row.
- SDXL with `weightSource=scratch` -> `400 SDXL_BASE_MODEL_REQUIRED`, no queue row.
- CPU SDXL conversion -> `503 SDXL_CONVERSION_GPU_REQUIRED`, no queue row.
- Missing SDXL Base directory on GPU -> executor failure, task `failed`, no model artifact registration.
- No usable train annotations -> executor preparation failure with task-specific message, no model artifact.
- Image or manifest output outside `FORGE_ARTIFACT_ROOT` -> preparation failure before image read/write.
- TorchScript load, ONNX checker, OpenVINO XML/BIN, or TensorRT builder failure -> conversion task `failed`; never register the expected filename blindly.

### 5. Good/Base/Bad Cases

- Good: an offline temporary polygon dataset loads cached NVIDIA SegFormer weights, performs one backward/optimizer step, emits loadable TorchScript, and produces ONNX with numerically consistent ONNX Runtime output; the temporary directory is removed automatically.
- Base: a CPU host trains HRNet from one valid train image with cached timm ImageNet weights and uses that image for validation because no validation split exists.
- Bad: write random bytes as `.onnx`, use only HRNet's first shallow feature, silently replace missing pretrained weights with random initialization, label a compact custom model as MMPose, accept SDXL on CPU, or call a fused UNet export a full SDXL pipeline.

### 6. Tests Required

- TypeScript dataset tests assert task filtering, normalized path containment, split counts, keypoint count, and missing-train rejection.
- API tests assert CPU SDXL training/conversion rejection, accept supported pretrained segmentation/keypoint requests, and ensure invalid weight sources create neither task nor queue item.
- Python command smoke covers every catalog family and asserts CPU SDXL rejection.
- `prefetch_models` must instantiate every catalog variant successfully in offline mode after the cache is populated.
- `acceptance_smoke --pretrained` must execute backward/optimizer, load TorchScript, export ONNX, run `onnx.checker` and ONNX Runtime, assert input-dependent output, and compare ONNX output numerically with TorchScript for SegFormer, U-Net, DeepLabV3+, HRNet, and HigherHRNet; `--all-cpu-formats` additionally loads the converted TorchScript and checks OpenVINO ZIP XML/BIN members.
- GPU release acceptance must run LoRA training with the approved Base on the target T4, load the SafeTensors through Diffusers, fuse it, and validate each exposed GPU format. Static import or dry-run is insufficient for claiming T4 validation.

### 7. Wrong vs Correct

#### Wrong

```py
Path(output_dir, "model.onnx").write_text('{"status":"completed"}')
# Or accept pretrained while build_segmentation_model() always initializes a config.
```

#### Correct

```text
persisted annotations + explicit weightSource -> versioned manifest
  -> cache-first pretrained backbone resolution (or explicit scratch)
  -> raster mask / heatmap -> model forward -> real loss.backward() -> optimizer.step()
  -> loadable TorchScript -> ONNX export -> onnx.checker
```

## Scenario: Model Architecture Variants And RK-Friendly ONNX

### 1. Scope / Trigger

- Trigger: adding a model family, instance-segmentation or pose task, architecture variant, model compatibility field, or RK-friendly ONNX export path.
- Reason: an RK label crosses the catalog, training request, database, Worker and conversion artifact. A UI-only badge or an export-only option can otherwise claim compatibility that the trained model and persisted lineage do not support.

### 2. Signatures

- `TrainingType` includes `instance_segmentation`; its standard data format is `YOLO_SEG`.
- `TrainingDraft.architectureVariant?: 'standard' | 'rk_compatible'` is validated and persisted in `training_jobs.config`.
- `ModelVariantMetadata = { architectureVariant, targetFamily?, rkCompatibilityStatus, outputProtocol, supportedOpset? }` is owned by `shared/modelCatalog.ts`.
- `model_versions` persists `architecture_variant`, `target_family`, `rk_compatibility_status`, and `output_protocol` through migration `010_model_architecture_variants.sql`.
- RK-friendly conversion invokes `forge_worker.convert onnx` with a fixed `--input-shape`, `--opset 12|13`, `--architecture-variant rk_compatible`, and no dynamic batch.
- Output protocols are `segmentation_logits | yolo_detection | yolo_segmentation | yolo_pose | heatmap | sdxl_unet`.

### 3. Contracts

- The model catalog is the source of truth for supported variants and their RK readiness. API, UI and Worker must import or derive from that catalog instead of maintaining independent compatibility lists.
- DeepLabV3+ exposes separate MobileNetV2 variants: `deeplabv3plus-mobilenetv2` is the standard backbone and `deeplabv3plus-mobilenetv2-rk` is the RK-specific backbone. The `-rk` model id always requires `architectureVariant='rk_compatible'`.
- YOLOv5u, YOLOv8, YOLOv8-Seg and YOLOv8-Pose may use the RK-friendly path. `YOLO_SEG` preserves per-instance polygons through `AnnotationRecord.instanceId`; COCO keypoints preserve optional visibility `0 | 1 | 2`.
- A standard-only catalog model must reject `rk_compatible`. Selecting `standard` must persist `standard_only` and must not inherit the catalog's RK badge accidentally.
- Successful training copies the selected architecture variant into `model_versions`; conversion reads the persisted model value rather than guessing from a display name.
- RK-friendly ONNX uses static batch 1, NCHW, a fixed spatial shape and opset 12 or 13. Detection NMS, segmentation mask decoding and pose decoding remain external runtime post-processing.
- `rk_structure_ready` means the structure and export contract are ready for a Rockchip NPU toolchain. It does not mean device validation, performance certification or RKNN generation.
- The platform exports ONNX only. It does not bundle RKNN Toolkit and must never describe an ONNX artifact as RKNN.

### 4. Validation & Error Matrix

- `model.endsWith('-rk')` with `architectureVariant!='rk_compatible'` -> `400 RK_VARIANT_REQUIRED`, no training row or queue item.
- `architectureVariant='rk_compatible'` for a standard-only catalog model -> `400 RK_VARIANT_UNAVAILABLE`, no training row or queue item.
- `instance_segmentation` with a format other than `YOLO_SEG` -> `400 VALIDATION_ERROR` with `fields.dataFormat`.
- RK-friendly ONNX with dynamic batch, batch other than 1, or opset outside 12/13 -> Worker configuration failure and no conversion artifact.
- Missing instance polygons for a YOLO-Seg train split -> training preparation failure and no model registration.
- Missing positive keypoint indices for YOLO-Pose -> training preparation failure and no model registration.

### 5. Good/Base/Bad Cases

- Good: train `deeplabv3plus-mobilenetv2-rk` with `rk_compatible`, persist `rockchip_npu` plus `segmentation_logits`, then export static batch-1 opset-13 ONNX with metadata.
- Base: train standard MobileNetV2, persist `standard_only`, then export a normal ONNX without an RK compatibility claim.
- Bad: train the standard backbone but change only the model badge to RK-friendly, allow dynamic RK ONNX, embed unsupported post-processing, or name an ONNX file `.rknn`.

### 6. Tests Required

- Shared schema/API tests assert valid and invalid task/format/architecture combinations and stable error codes.
- Migration smoke asserts the new task/format constraints and all four model lineage columns.
- Dataset tests assert YOLO-Seg instance grouping and YOLO-Pose visibility/index handling.
- Worker command smoke asserts YOLO-Seg, YOLO-Pose and both MobileNetV2 variants route to their intended trainers.
- Conversion smoke asserts RK-friendly ONNX uses static batch 1 and opset 12/13, passes `onnx.checker`, and contains architecture, target-family, input-shape and output-protocol metadata.
- Frontend tests assert the five task cards, standard/RK model labels, disabled invalid architecture choices, and RK conversion controls.

### 7. Wrong vs Correct

#### Wrong

```ts
const rkCompatible = modelName.includes('yolo');
await createConversion({ dynamicBatch: true, opset: 18 });
```

#### Correct

```ts
const metadata = modelVariantMetadata(modelName);
if (draft.architectureVariant === 'rk_compatible' && metadata?.architectureVariant !== 'rk_compatible') {
  throw new HttpError(400, 'RK_VARIANT_UNAVAILABLE', 'The selected model has no RK-friendly variant');
}

await runConversion({
  architectureVariant: model.architectureVariant,
  inputShape: `1,3,${imageSize},${imageSize}`,
  opset: 13,
  dynamicBatch: false,
});
```
