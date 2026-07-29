# 工业质检训练平台产品化 - 技术设计

## Deployment Shape

首版是企业内网单租户一体化部署：Docker Compose 编排 Web、API、Worker、PostgreSQL、Redis 和 MinIO。所有容器通过同一内部网络通信，只有 Web/API 暴露给用户网络。生产镜像基线为 Ubuntu 22.04 + NVIDIA Container Toolkit，训练节点挂载 `2 x NVIDIA T4 16GB`；CPU-only API 和数据服务可独立运行。

## Repository Boundaries

```text
src/                         React product UI
server/                      Node.js API, auth, repositories, queue producers
worker/                      Python execution adapters and artifact handlers
db/migrations/               PostgreSQL schema migrations and seed data
docker/                      API/worker runtime images and compose overrides
shared/                      Versioned API contracts shared by UI and server
```

前端不直接导入 `data/mockData.ts` 作为业务真源。`shared/contracts` 定义 DTO、枚举和错误结构；`src/services/apiClient.ts` 负责认证、重试和错误映射；`AppContext` 只保留会话、Toast 和查询缓存协调。

## Runtime Components

- **Web**：Vite 构建的静态前端，由 Nginx 或 API 进程托管。
- **API**：Fastify + TypeScript，负责鉴权、输入校验、事务、预签名上传、任务入队和查询。
- **PostgreSQL**：领域真源，使用 SQL migration 管理 schema，所有任务和资产带 `workspace_id`、`created_by`、`updated_at`。
- **Redis/BullMQ**：训练、导出和转换队列，任务状态仍写 PostgreSQL，Redis 只负责调度和重试。
- **失败任务重新训练**：只允许管理员或算法工程师对 `failed` 任务操作；服务端从任务的持久化 `config` 复制参数并按当前数据集、模型和硬件能力重新校验，以新任务 ID 入队。原失败记录保持不变，新任务事件和审计日志记录来源任务 ID。
- **训练任务删除**：只允许管理员或算法工程师删除已完成、失败或已取消任务。服务端先移除对应 CPU/GPU BullMQ 记录，再删除任务及级联日志、指标和资源采样；已登记模型、制品元数据和文件继续保留。活动任务返回 409 并要求先停止。
- **MinIO**：S3 兼容对象存储，保存原图、导出包、checkpoint、模型和转换产物。
- **Worker**：按队列消费任务，执行器通过容器命令或 Python runner 调用模型框架；T4 节点通过 `NVIDIA_VISIBLE_DEVICES` 分配 GPU。

## Domain Model

核心表：`workspaces`, `users`, `datasets`, `dataset_versions`, `dataset_images`, `labels`, `annotations`, `training_jobs`, `training_events`, `model_versions`, `conversion_jobs`, `artifacts`, `audit_logs`。

- 标注坐标存储为 JSONB 的归一化坐标，类型为 `rectangle | polygon | keypoint`；每次保存携带 `revision`，更新使用乐观锁。
- 训练配置和转换配置以 JSONB 保存原始输入，同时对核心字段建立结构化列和数据库约束。
- 任务状态采用有限状态机：`queued -> running -> completed | failed | cancelled`；非法迁移由服务层拒绝。
- 产物只保存对象存储 key、大小、sha256、mime、来源任务和创建人，不把二进制写入 PostgreSQL。

## API Contract

前缀为 `/api/v1`，错误统一为：

```json
{
  "error": { "code": "VALIDATION_ERROR", "message": "...", "fields": { "epochs": "必须大于 0" }, "requestId": "..." }
}
```

首批资源：

- `POST /auth/login`, `GET /auth/me`
- `GET/POST /datasets`, `GET /datasets/:id`, `POST /datasets/:id/exports`
- `GET/PUT /datasets/:id/images/:imageId/annotations`
- `GET/POST /training/jobs`, `GET/DELETE /training/jobs/:id`, `POST /training/jobs/:id/cancel`, `POST /training/jobs/:id/retry`
- `GET/POST /conversions`, `GET /conversions/:id`, `POST /conversions/:id/cancel`
- `GET /models`, `GET /models/:id`, `GET /artifacts/:id/download`
- `GET /health`, `GET /ready`

所有非登录路由要求 Bearer token 和 workspace 作用域。管理员可管理用户与资源；算法工程师可写训练/模型/转换；标注员只能写标注和提交审核。

## Model And Executor Catalog

模型目录使用稳定的 `family` 与 `variant`：

- detection: `yolov5`, `yolov8`
- segmentation: `segformer`, `unet`, `deeplabv3plus`
- keypoint: `hrnet`, `higherhrnet`
- sdxl: `sdxl-lora`, `sdxl-dreambooth`（ControlNet 等待成对条件图数据契约）

每个目录项声明支持的数据集类型、默认输入尺寸、显存预算、精度、训练命令和产物规则。Worker 不在 API 进程中 import 深度学习框架；它只运行匹配的执行器镜像，并把 stdout/stderr 解析为结构化事件。

训练执行器必须支持：配置校验、启动、进度事件、指标事件、日志、取消、失败原因、checkpoint 注册。转换执行器对 ONNX、TensorRT、TorchScript、OpenVINO 分别声明目标硬件和精度约束。T4 默认 FP16，TensorRT engine 构建固定 CUDA/cuDNN/TensorRT 版本并记录环境指纹。

## Auth And Audit

首版使用本地账户、Argon2id 密码哈希、短期 access token 和可轮换 refresh token。密码明文不落库；登录失败使用统一错误，审计记录登录、标注保存、任务创建/取消、产物下载和用户变更。单租户不等于跳过身份校验，默认种子账号首次登录必须改密。

## Compatibility And Rollback

- 本地开发提供 in-memory repository 适配器和 Docker Compose PostgreSQL/Redis/MinIO；集成测试使用 Testcontainers 或临时 Compose 数据服务。
- API DTO 通过 `apiVersion` 和迁移脚本演进，不从页面组件直接暴露数据库字段。
- Worker 失败只影响当前任务，API 和已完成产物保持可查询；升级时先迁移 schema，再滚动更新 Worker，失败可回退到上一个镜像。
- AGPL-3.0 依赖和模型权重来源写入 `THIRD_PARTY_NOTICES.md`，产品分发保留许可证与源码获取说明。

## Task-Neutral Datasets And Standard Formats

### Shared Contract

- `Dataset` no longer exposes a required task type. `legacyType?: '目标检测' | '语义分割' | '关键点'` may be returned for migrated rows but is display-neutral and never gates a task.
- `DatasetCreateInput` contains `name`, `description`, `version`, and `classes`; `type` is removed from UI and request validation.
- `DataFormat` contains `YOLO | COCO | VOC | COCO_SEGMENTATION | PNG_MASK | COCO_KEYPOINTS`.
- `TrainingDraft.dataFormat` is required for detection, segmentation, and keypoint jobs. SDXL uses its existing fixed image/prompt input and does not accept these values.
- One shared compatibility map owns task-to-format validation:
  - detection: `YOLO | COCO | VOC`
  - segmentation: `COCO_SEGMENTATION | PNG_MASK`
  - keypoint: `COCO_KEYPOINTS`

### Persistence And Migration

- Migration `008_task_neutral_datasets_and_formats.sql` drops the `datasets.type` NOT NULL/check constraint while preserving existing values.
- New dataset rows store `type = NULL`; no historical dataset row is rewritten or deleted.
- Existing export value `SEGMENTATION` is migrated to `PNG_MASK`, then the export format constraint is replaced with the complete standard-format set.
- Training format remains in the versioned `training_jobs.config` JSONB so retry preserves the exact original format.

### Export Flow

`annotations -> select format-compatible approved records -> materialize standard package -> validate package -> ZIP -> artifact`

- YOLO writes split image/label directories plus `dataset.yaml`.
- COCO writes bbox/polygon `annotations.json`; VOC writes bounding-box XML files.
- COCO Segmentation writes polygon/rectangle segmentation arrays; PNG Mask writes indexed PNG masks plus class mapping.
- COCO Keypoints groups all numbered points in an image into one instance. The instance bbox encloses visible points, missing indices use COCO zero visibility, keypoint names are stable `point_1..point_N`, and `skeleton` is empty in the first version.
- An image is exportable only when it contains at least one annotation compatible with the selected format. Unannotated and incompatible-only images are excluded and counted in the manifest.

### Training Flow

`TrainingDraft.dataFormat -> materialize selected standard package -> parse/validate selected package -> framework-native runtime dataset -> real trainer`

- The selected format cannot be ignored. Each adapter first writes the selected standard representation and reads it back through a format-specific parser.
- Detection parsers normalize YOLO/COCO/VOC into the YOLO runtime layout required by Ultralytics.
- Segmentation parsers normalize COCO Segmentation/PNG Mask into the structured manifest consumed by SegFormer/U-Net/DeepLabV3+.
- COCO Keypoints parser normalizes the single-instance records into numbered heatmaps consumed by HRNet/HigherHRNet.
- API rejects task/format mismatches before enqueue. Worker rejects malformed or empty selected-format packages without registering an artifact.

### Frontend

- Dataset creation and dataset list remove the task type field/column. All annotation tools remain available.
- Export format cards are grouped by detection, segmentation, and keypoint use.
- Training wizard selects task first, then shows only compatible data formats in the data/model step. Dataset selection includes every reviewed dataset; format-specific annotation availability is validated on submit.
- Training detail and retry display/preserve `dataFormat`.

### Rollback

- Application rollback remains compatible with historical non-null dataset types.
- Database rollback must not restore NOT NULL until all task-neutral rows have been assigned a legacy type; therefore operational rollback should revert application containers while leaving migration 008 in place.

## Annotation Workspace And SDXL Captions

### Document Contract

`annotation_documents` remains the optimistic-lock and review boundary. Geometry stays in the existing `annotations` JSONB column; migration 009 adds `captions JSONB NOT NULL DEFAULT '[]'` and `image_attributes JSONB NOT NULL DEFAULT '{}'`. Old clients may omit both fields and keep their previous values. New saves send the complete document content atomically.

Vector geometry expands with `polyline`, `ellipse`, and `skeleton`. A two-point polyline is displayed as a line segment; longer polylines represent cracks or seams. Skeleton nodes retain positive keypoint indices and visibility, while standalone legacy keypoints remain supported. Image-level tags and SDXL inclusion/crop state live in `image_attributes` because they do not have canvas geometry.

### Workspace Interaction

The page keeps normalized `0..100` image coordinates and the natural bitmap aspect ratio. Pointer sessions own draw/move/resize gestures synchronously. Every vector object exposes appropriate edit handles; lock prevents mutation while visibility only affects rendering. Undo/redo records complete document snapshots so geometry, captions and image attributes follow one consistent history.

### SDXL Flow

`approved annotation document -> includeInSdxl + primary caption -> Image Folder images + metadata.jsonl -> structured dataset manifest -> SdxlImageDataset -> SDXL LoRA trainer`

The canonical Image Folder metadata row is `{ "file_name": "...", "text": "..." }`. The structured manifest carries the same text as `prompt`. New SDXL jobs require at least one approved training image with a non-empty primary Caption. Legacy automatic prompts are readable only for already materialized manifests and are never silently generated for a new job.

## Metric Chart Axes

Metric series declare `axis: left | right` and an optional formatter. Score metrics use a stable `0..1` left scale; loss uses a separately computed nice-number right scale. SVG grid rows render both tick values. A transparent pointer overlay resolves the nearest Epoch and renders a crosshair and tooltip. Legend buttons toggle series without deleting underlying observations.
