# Forge AI 部署说明

本文面向企业内网、单工作空间的 Docker Compose 部署。默认 CPU-only 模式启动 Web、API、PostgreSQL、Redis、MinIO、导出 Worker 和 CPU 计算 Worker；具备 NVIDIA GPU 的主机可额外启用 GPU Worker。浏览器访问 Web，Web 在构建时写入 API 地址，API 将任务写入 Redis，Worker 将任务状态和产物元数据写回 PostgreSQL。

## 1. 部署前检查

目标主机需要 Linux x86_64、Docker Engine 和 Docker Compose v2；CPU-only 模式不要求显卡、NVIDIA 驱动或 CUDA。CPU Worker 镜像会安装 CPU 版 PyTorch、Ultralytics、ONNX 和 OpenVINO，首次构建需要访问 Python/PyTorch 依赖源。GPU Worker 还需要 NVIDIA 驱动和 NVIDIA Container Toolkit；主机不需要安装 Node.js、Python 或 CUDA Toolkit。

```bash
docker --version
docker compose version
```

仅在启用 GPU profile 前执行以下检查：

```bash
nvidia-smi
docker run --rm --gpus all nvidia/cuda:12.1.1-cudnn8-runtime-ubuntu22.04 nvidia-smi
```

该命令应列出预期 GPU。若失败，先修复驱动或 NVIDIA Container Toolkit，再构建 GPU Worker 镜像。GPU Worker 镜像构建会下载 Python 与 NVIDIA 推理依赖；隔离网络必须预先镜像并配置内部镜像仓库。

CPU Worker 默认使用阿里云 Debian 与 PyPI 镜像加速依赖下载。企业内网有自建镜像时，可通过 `DEBIAN_MIRROR`、`DEBIAN_SECURITY_MIRROR`、`PYPI_INDEX_URL` 和 `PYTORCH_INDEX_URL` Docker build args 替换；隔离部署前应将这些依赖全部同步到内部制品仓库或镜像缓存。

需要向用户网络放行的端口：Web `5174/tcp` 和 API `4000/tcp`。PostgreSQL、Redis 和 MinIO S3 API 只在 Compose 网络内通信。MinIO 控制台默认只绑定到 `127.0.0.1:19001`。此端口组合避开当前宿主已被占用的 `5173` 和 `9001`。

> 合规前提：Worker 镜像会集成 Ultralytics/YOLO 的 AGPL 路径。当前仓库尚未包含 `LICENSE` 和 `THIRD_PARTY_NOTICES.md`，因此在对外分发前必须完成许可证文本、源码提供方式、修改说明和权重来源记录。

## 2. 配置内网地址与密钥

在项目根目录创建生产配置：

```bash
cp .env.example .env
chmod 600 .env
openssl rand -base64 48
```

将生成的随机值写入 `JWT_SECRET`，并替换 PostgreSQL 与 MinIO 密码。以当前服务器 IP `172.16.66.249` 的内网部署为例；域名部署时将 IP 换为实际 HTTPS 地址。

```dotenv
COMPOSE_PROJECT_NAME=forge-ai

POSTGRES_PASSWORD=<高强度数据库密码>
MINIO_ROOT_USER=forge-minio
MINIO_ROOT_PASSWORD=<高强度MinIO密码>
JWT_SECRET=<至少32字符的随机密钥>
BOOTSTRAP_ADMIN_USERNAME=admin
BOOTSTRAP_ADMIN_PASSWORD=<至少12字符的初始管理员密码>
BOOTSTRAP_ADMIN_DISPLAY_NAME=平台管理员
ALLOW_WEAK_BOOTSTRAP_PASSWORD=false
FORGE_GPU_ENABLED=false
FORGE_CPU_TRAINING_ENABLED=true
FORGE_CPU_ONNX_ENABLED=true

CORS_ORIGIN=http://172.16.66.249:5174
VITE_API_BASE_URL=http://172.16.66.249:4000/api/v1

WEB_BIND=0.0.0.0
WEB_PORT=5174
API_BIND=0.0.0.0
API_PUBLIC_PORT=4000
MINIO_CONSOLE_BIND=127.0.0.1
MINIO_CONSOLE_PORT=19001
```

`VITE_API_BASE_URL` 会编译进 Web 静态文件，变更后必须重新构建 Web 镜像。`CORS_ORIGIN` 必须与用户浏览器访问 Web 的完整 Origin 完全一致，包括协议、主机和端口。不要将二者写为浏览器本机的 `localhost`，除非用户就在部署服务器上访问。

若在同一域名的反向代理后部署，例如 `https://forge.example.internal`，设置：

```dotenv
CORS_ORIGIN=https://forge.example.internal
VITE_API_BASE_URL=https://forge.example.internal/api/v1
API_BIND=127.0.0.1
WEB_BIND=127.0.0.1
```

反向代理应将 `/api/` 转发到 `http://127.0.0.1:4000/`，其余路径转发到 `http://127.0.0.1:5174/`，并在代理层终止 TLS。

## 3. 首次启动

CPU-only 主机使用默认路径：

```bash
docker compose config
docker compose build
docker compose up -d
docker compose ps
```

该路径不会构建或拉取 CUDA 镜像。`export-worker` 消费导出队列，`cpu-worker` 消费真实 YOLO、语义分割、关键点 CPU 训练与 FP32 ONNX、TorchScript、OpenVINO 转换队列。页面显示 CPU Worker 已启用；TensorRT 和 SDXL 保持禁用。

GPU 主机需要先在 `.env` 设置 `FORGE_GPU_ENABLED=true`，然后显式启用 profile：

```bash
docker compose --profile gpu up -d --build
docker compose --profile gpu ps
```

GPU profile 启动 `worker`，它消费 GPU 训练与转换队列；默认 `export-worker` 和 `cpu-worker` 仍然运行。

API 服务启动命令会顺序执行 `npm run db:migrate`、`npm run db:seed` 和 `npm run start:api`。Migration 通过 `schema_migrations` 记录，重复启动不会重复执行已完成的 SQL；seed 只创建默认工作空间和一个由 `BOOTSTRAP_ADMIN_*` 指定的管理员，不会创建数据集、任务、模型、转换或标注示例。

升级现有部署不会删除 PostgreSQL 或产物卷中的历史记录。需要验收全新的空工作区时，应为 `COMPOSE_PROJECT_NAME` 使用一个尚未使用过的名称，从而创建全新持久卷；不要对仍需保留数据的部署执行 `docker compose down -v`。

观察首次构建和启动日志：

```bash
docker compose logs -f --tail=200 postgres redis api export-worker cpu-worker web
```

初始化账号由 `BOOTSTRAP_ADMIN_USERNAME`、`BOOTSTRAP_ADMIN_PASSWORD` 和 `BOOTSTRAP_ADMIN_DISPLAY_NAME` 注入，角色固定为管理员。密码只在首次创建账号时写入；若数据库已经存在该账号，重新启动不会覆盖其已修改的密码。不要在文档、镜像或脚本中写入固定初始密码。

`BOOTSTRAP_ADMIN_PASSWORD` 默认至少需 12 个字符。仅在必要与旧系统对接时，可将 `ALLOW_WEAK_BOOTSTRAP_PASSWORD=true` 与 5-11 个字符的密码同时设置；该开关应在更换为高强度密码后恢复为 `false`。

## 4. 启动验证

```bash
curl -fsS http://127.0.0.1:4000/api/v1/health
curl -fsS http://127.0.0.1:4000/api/v1/ready
docker compose exec redis redis-cli ping
docker compose exec postgres psql -U forge -d forge -c 'SELECT id, applied_at FROM schema_migrations ORDER BY id;'
docker compose exec postgres psql -U forge -d forge -c 'SELECT username, role FROM users ORDER BY username;'
```

CPU-only 预期：两个 HTTP 接口返回 `status` 为 `ok` / `ready`，Redis 返回 `PONG`，`export-worker` 与 `cpu-worker` 正常运行，migration 包含已应用的 SQL。随后从另一台内网机器打开 `http://<服务器地址>:5174/`，使用 `.env` 中的管理员账号登录；工作台应显示 CPU Worker 已启用，真实 YOLO CPU 训练与 FP32 ONNX、TorchScript、OpenVINO 转换可提交，TensorRT 不可提交。

YOLO 转换优先使用平台训练生成且带模型家族血缘的 `best.pt`，会调用 YOLOv5/YOLOv8 对应官方导出器并校验结果。OpenVINO 产物以包含 XML 与 BIN 的 ZIP 提供。已有 `.onnx` 会在校验后复制，通用 TorchScript/JIT 可执行 ONNX 导出；无法识别模型家族的普通 PyTorch state dict 会明确失败，不会生成伪模型文件。

标注审核按“数据集级提交、图像级决策”运行：标注员可以跨图片保存草稿，完成全部图片后点击“提交审核”；提交中的图像为只读。管理员或工程师从数据中心的“待审核”数据集进入审核工作台，可逐张或批量通过/驳回，驳回必须填写原因。数据集只有在所有图像均为“已通过”时才变为“可训练”，训练和正式导出接口也会以 `DATASET_REVIEW_REQUIRED` 拒绝未通过审核的数据集。已通过标注再次编辑会回到草稿并要求重新审核，新增图片也会使数据集回到“标注中”。

升级时 `007_annotation_reviews.sql` 会为标注文档增加 `draft`、`submitted`、`approved`、`rejected` 状态和提交/审核人员、时间、原因字段。为兼容升级前“有标注即就绪”的规则，已有非空标注文档在首次迁移时会登记为已通过，不删除或重写标注几何数据。`009_annotation_workspace_and_sdxl_captions.sql` 增加 Caption、图像标签/裁剪属性和 Image Folder 导出约束，旧矩形、多边形、关键点 JSON 保持可读。

数据集创建时不绑定任务类型。训练向导选择任务后只显示兼容的标准格式：目标检测为 YOLO、COCO、VOC；语义分割为 COCO Segmentation、PNG Mask；关键点为 COCO Keypoints；SDXL 固定使用 Image Folder + Caption。格式值保存在训练配置中，Worker 会先生成所选标准格式，再通过对应解析器读回为框架原生训练数据。

标注工作台支持矩形、多边形、线段/折线、椭圆、关键点和骨架；对象可移动、编辑控制点、隐藏和锁定。SDXL 页签按图保存是否纳入训练、主 Caption、语言、标签和可选归一化裁剪区域。勾选“纳入训练”后必须填写主 Caption，所有几何与图像级字段共用同一个 revision、统一保存和审核状态。

YOLO 训练只读取数据集中包含有效矩形框或多边形的已标注图片，并要求 `train` 分片至少有一张有效图片。若没有独立 `validation` 分片，执行器会使用训练分片完成验证。CPU 建议从 `yolov8n`/`yolov5n`、batch 1-4 开始；CPU 真实训练可能耗时数小时，生产训练优先使用 GPU Worker。

语义分割训练只读取标签属于数据集类别的矩形框/多边形标注，并将其栅格化为背景加类别索引 mask；关键点训练读取正整数编号的关键点并生成高斯热图，COCO Keypoints 首版按每张图一个对象实例组织。两者都要求 `train` 分片至少有一张有效标注图；没有 `validation` 时使用训练分片验证。SegFormer 加载 NVIDIA MiT 权重，U-Net 和 DeepLabV3+ 加载 TorchVision ImageNet ResNet 编码器权重，HRNet/HigherHRNet 加载 timm ImageNet HRNet 主干；任务产物清单会记录 `dataFormat`、`weightSource` 和 `pretrainedSource`。向导也保留“从头训练”选项。CPU 建议先用 128-384 输入、batch 1-4 验证数据契约，再扩大正式训练配置。

成功的分割和关键点任务生成可加载的 `model.torchscript.pt`。通用转换器可将平台生成的 TorchScript 真实导出为 ONNX、TorchScript 和 OpenVINO；GPU Worker 可经 ONNX 构建 TensorRT engine。手工上传的普通 state dict 缺少网络结构，不能自动转换，需上传 TorchScript/JIT、ONNX 或具有可识别血缘的 YOLO 权重。

训练中心每 3 秒刷新任务状态、Epoch、总体进度、主指标、指标曲线和资源采样。指标图左轴显示 mAP、Precision、Recall、mIoU、OKS 等质量分数，右轴独立显示 Loss 刻度，图例显示最新精确值，悬浮/触摸显示对应 Epoch 的全部数值。YOLO 从框架生成的 `results.csv` 增量读取 loss、Precision、Recall、mAP@50 和 mAP@50-95；分割、关键点与 SDXL 通过结构化 Runner 事件上报。CPU Worker 采集训练进程树的 CPU 与内存，GPU Worker 额外通过 `nvidia-smi` 采集利用率、显存和功耗。指标和遥测写入 PostgreSQL，关闭浏览器不会丢失。历史 YOLO 任务可从保留的 `results.csv` 回填 Epoch 指标，但任务结束后无法重建历史资源采样。

选择“官方预训练权重”时，首次训练会获取对应权重并缓存到共享卷的 `/data/model-cache`。平台的 YOLOv5 选项对应 Ultralytics YOLOv5u 权重族。完全离线部署可在训练向导选择“从头训练（离线可用）”，Worker 将使用镜像内置的模型 YAML 初始化真实网络；也可预先准备所需的 `yolov5nu.pt` / `yolov5su.pt` 等 YOLOv5u 权重和 `yolov8n.pt` / `yolov8s.pt` 等 YOLOv8 权重，再写入卷：

```bash
docker run --rm -v forge-ai_forge-worker-data:/data -v "$PWD/weights":/weights:ro alpine sh -c 'mkdir -p /data/model-cache && cp /weights/*.pt /data/model-cache/'
```

SegFormer B0-B5、U-Net、DeepLabV3+ ResNet50/101、HRNet W32/W48 和 HigherHRNet W32/W48 可一次预下载并验证。该命令复用 `forge-worker-data` 卷，CPU/GPU Worker 都能读取同一缓存。无法直连 Hugging Face 的网络可在 `.env` 将 `HF_ENDPOINT` 指向企业模型代理或兼容镜像：

```bash
docker compose run --rm cpu-worker env PYTHONPATH=/app/worker python3 -m forge_worker.prefetch_models
```

离线加载和一次真实反向传播可通过以下隔离验收验证，不会创建业务任务或写入 PostgreSQL：

```bash
docker compose run --rm cpu-worker env PYTHONPATH=/app/worker python3 -m forge_worker.acceptance_smoke --pretrained
```

下载成功后将 `.env` 设置为 `FORGE_PRETRAINED_OFFLINE=true`，再执行 `docker compose up -d --force-recreate cpu-worker`；GPU profile 同时重建 `worker`。离线模式缺少某个权重时任务会明确失败，不会静默改用随机初始化。SegFormer 支持将完整 Hugging Face 模型目录放到 `/data/model-cache/pretrained/<模型名>`，也支持兼容权重文件 `/data/model-cache/pretrained/<模型名>.pth`；HRNet/HigherHRNet 支持同名 timm `.pth` checkpoint。

模型仓库支持直接上传 `.pt`、`.pth`、`.onnx`、`.safetensors`、`.torchscript`、OpenVINO `.xml/.bin` 文件，单文件上限为 512 MB。上传文件与数据集图像都写入 `forge-worker-data` 共享卷并登记制品元数据，因此该卷必须纳入备份。

数据集导出由 CPU `export-worker` 生成 ZIP 产物，并统一排除没有标注或与所选格式不兼容的图片。YOLO 写入 `images/labels` 与 `dataset.yaml`；COCO Detection、COCO Segmentation 和 COCO Keypoints 写入对应标准 JSON；VOC 写入逐图 XML 与划分清单；PNG Mask 写入 8 位类别索引掩码和 `classes.json`；Image Folder 写入入选图片和逐图 `metadata.jsonl`。七种格式都会包含 `manifest.json`；启用“包含图像”时只复制实际进入导出的原图。共享卷需要同时容纳原始数据、正在生成的临时包和最终 ZIP，容量规划应预留至少一份完整数据集的额外空间。

GPU profile 额外验证：

```bash
docker compose --profile gpu exec worker nvidia-smi
```

### SDXL 基础模型与 LoRA

SDXL 任务不会在运行时从公网拉取基础模型。先将完整的 Diffusers 格式 SDXL Base 目录写入共享卷的 `/data/model-cache/stable-diffusion-xl-base-1.0`，目录至少应包含 `model_index.json`、`tokenizer*`、`text_encoder*`、`vae`、`unet` 和 `scheduler`。`FORGE_SDXL_BASE_MODEL` 可修改容器内路径，但该路径必须在 GPU Worker 中可见。

```bash
docker run --rm \
  -v forge-ai_forge-worker-data:/data \
  -v /opt/internal-models/stable-diffusion-xl-base-1.0:/source:ro \
  alpine sh -c 'mkdir -p /data/model-cache/stable-diffusion-xl-base-1.0 && cp -a /source/. /data/model-cache/stable-diffusion-xl-base-1.0/'
docker compose --profile gpu exec worker test -f /data/model-cache/stable-diffusion-xl-base-1.0/model_index.json
```

平台开放 UNet LoRA 与 DreamBooth LoRA，固定 batch 1、FP16 和梯度检查点；不支持 SDXL 全参数训练。输出为 Diffusers SafeTensors LoRA。ONNX、TorchScript、OpenVINO、TensorRT 转换会加载相同 Base、融合 LoRA，并只导出部署所需的 SDXL UNet 组件，不是完整文本编码器/VAE/Pipeline 包。ControlNet 暂不开放，原因是当前数据集没有成对条件图与目标图契约。

CPU 主机会在 SDXL 训练入队前返回 `SDXL_GPU_REQUIRED`，在 SDXL 转换入队前返回 `SDXL_CONVERSION_GPU_REQUIRED`。Base 目录缺失时 GPU 执行器明确失败且不登记模型产物。

## 5. 日常运维

查看状态和日志：

```bash
docker compose ps
docker compose logs --tail=200 api
docker compose logs --tail=200 export-worker
docker compose logs --tail=200 cpu-worker
docker compose logs -f export-worker
```

仅重启某个服务：

```bash
docker compose restart api
docker compose restart export-worker
docker compose restart cpu-worker
```

不要使用 `docker compose down -v` 进行普通重启；`-v` 会删除 PostgreSQL、Redis、MinIO 和 Worker 产物卷。

### 5.1 删除与磁盘清理

管理员或算法工程师在页面删除业务资源时，平台会同步清理其数据库记录和共享卷产物：

- 删除数据集：删除原始图像、标注记录、导出任务及导出 ZIP。
- 删除训练任务：删除日志、指标、资源采样、训练输出，以及该任务生成的模型版本和转换产物。
- 删除模型：删除原始模型权重、关联转换任务及其产物。训练任务记录仍保留，但不再提供已删除的模型下载。
- 删除转换任务：删除终态转换记录、CPU/GPU 队列中的保留任务、产物元数据和对应的 `conversions/<任务ID>` 目录。

活动中的训练或转换任务必须先取消。删除接口会等待 BullMQ 任务释放活动锁；关联导出或转换仍在结束时会返回冲突，稍后重试即可。页面成功提示会显示本次实际释放的磁盘空间。

升级历史版本后，先用 dry-run 检查“数据库记录已删除但目录仍残留”的孤立产物：

```bash
docker compose exec -T api npm run artifacts:cleanup
```

确认输出中的 `danglingModelIds`、`orphanConversionIds`、`orphanArtifactIds` 和 `storage.directories` 都属于应删除内容后，再执行：

```bash
docker compose exec -T api npm run artifacts:cleanup -- --execute
```

该命令只处理 `/data/artifacts` 下受管的数据集、导出、训练、转换、上传模型和运行时目录，并在删除前再次校验数据库引用。排队或运行中的记录会保留；`/data/model-cache` 预训练权重缓存永远不在清理范围内。执行前仍应按第 6 节完成 PostgreSQL 与 Worker 产物卷备份。

## 6. 备份与恢复

在升级前和定期任务中备份 PostgreSQL、MinIO 和 Worker 产物。以下命令假设 `COMPOSE_PROJECT_NAME=forge-ai`，备份文件保存在项目的 `backups/` 中：

```bash
mkdir -p backups
docker compose exec -T postgres pg_dump -U forge -d forge -Fc > backups/forge-$(date +%F-%H%M%S).dump
docker run --rm -v forge-ai_forge-minio:/source:ro -v "$PWD/backups":/backup alpine tar czf /backup/minio-$(date +%F-%H%M%S).tgz -C /source .
docker run --rm -v forge-ai_forge-worker-data:/source:ro -v "$PWD/backups":/backup alpine tar czf /backup/worker-artifacts-$(date +%F-%H%M%S).tgz -C /source .
```

恢复 PostgreSQL 前先停止写入服务：

```bash
docker compose stop api export-worker cpu-worker worker web
cat backups/<数据库备份>.dump | docker compose exec -T postgres pg_restore -U forge -d forge --clean --if-exists
docker compose start api export-worker cpu-worker worker web
```

恢复卷归档会覆盖目标卷中的文件，只能在确认备份来源和目标卷名称后操作：

```bash
docker compose stop api export-worker cpu-worker worker
docker run --rm -v forge-ai_forge-worker-data:/target -v "$PWD/backups":/backup alpine sh -c 'rm -rf /target/* && tar xzf /backup/<产物备份>.tgz -C /target'
docker compose start api export-worker cpu-worker worker
```

MinIO 卷恢复使用相同模式，将卷名替换为 `forge-ai_forge-minio`。恢复后先检查 migration 和 artifact 元数据，再开放 Web 写入流量。

## 7. 升级与回退

升级前完成备份，并保留当前已构建镜像标签或镜像 ID：

```bash
docker compose images
docker compose build --pull
docker compose run --rm --no-deps api npm run db:migrate
docker compose up -d --remove-orphans
docker compose ps
```

`db:migrate` 只会向前应用新增 migration。不要修改已经在生产数据库执行过的 SQL 文件；新增结构必须使用下一个编号文件。若 Web 的 `VITE_API_BASE_URL` 变更，必须执行 `docker compose build web` 后再 `docker compose up -d web`。

代码或镜像回退只能在没有不兼容 migration 的前提下进行。若 migration 已改变数据模型，先恢复对应 PostgreSQL 备份，再恢复先前镜像；不要仅回退容器镜像。

## 8. 故障排查

| 现象 | 检查与处理 |
| --- | --- |
| 内网浏览器登录后请求 `localhost:4000` | `.env` 中仍使用 localhost；设置实际服务器 IP/域名的 `VITE_API_BASE_URL` 与 `CORS_ORIGIN`，然后执行 `docker compose build web && docker compose up -d --force-recreate web api`。 |
| 浏览器报 CORS 错误 | `CORS_ORIGIN` 与 Web 实际地址不一致；检查协议、主机和端口，重建并重启 API。 |
| 上传或删除显示 `Failed to fetch` | 检查浏览器 Network 中的预检响应；除 `204` 外，`Access-Control-Allow-Methods` 还必须包含实际使用的 `PUT`、`PATCH` 或 `DELETE`。当前 API 已显式开放这些产品方法。 |
| GPU profile 的 Worker 启动但没有 GPU | 执行 `docker run --rm --gpus all ... nvidia-smi`；失败说明 Docker 未接入 NVIDIA runtime。检查主机驱动和 NVIDIA Container Toolkit。 |
| CPU 训练返回 `TRAINING_WORKER_UNAVAILABLE` | 确认 `.env` 中 `FORGE_CPU_TRAINING_ENABLED=true`，并检查 `docker compose ps cpu-worker` 与 `docker compose logs cpu-worker`。 |
| CPU 转换返回 `CPU_CONVERSION_UNAVAILABLE` | CPU 模式支持 ONNX、TorchScript、OpenVINO 的 FP32 转换；TensorRT 必须启用 GPU profile。 |
| 分割/关键点任务提示无法加载预训练权重 | 联网环境执行 `docker compose run --rm cpu-worker env PYTHONPATH=/app/worker python3 -m forge_worker.prefetch_models`；离线环境检查共享卷缓存是否完整，并确认 `FORGE_PRETRAINED_OFFLINE=true`。系统不会静默退回随机初始化。 |
| SDXL 返回 `SDXL_GPU_REQUIRED` / `SDXL_CONVERSION_GPU_REQUIRED` | SDXL 的训练、LoRA 融合和 UNet 转换需要 CUDA Worker；CPU-only 部署不会接收该任务。 |
| SDXL 提示 Base 路径不存在 | 按启动验证章节预置完整 Diffusers SDXL Base，并确认 `FORGE_SDXL_BASE_MODEL` 指向 GPU 容器内可读目录。 |
| 模型转换返回源模型/家族错误 | 优先选择平台 YOLO 训练生成的模型；手工上传的普通 state dict 不能安全重建网络，需提供可识别的 YOLOv5/YOLOv8 framework 血缘、TorchScript/JIT 或 ONNX。 |
| YOLO 训练提示训练分片无有效框 | 确认所选数据集的 `train` 分片至少有一张已保存矩形框或多边形标注的图片，且标注标签存在于数据集类别中。 |
| YOLO 首次训练无法获取权重 | 检查 Worker 外网/内部制品源，或按启动验证章节将官方 `.pt` 权重预置到 `/data/model-cache`。 |
| Worker 反复失败 | CPU 队列查看 `docker compose logs --tail=300 cpu-worker`，GPU 队列查看 `worker`；同时检查任务 `error_message` 和 Redis 连通性。Worker 会将失败任务持久化为 `failed`。 |
| API 启动失败 | 先看 `docker compose logs api postgres redis`；确认 `.env` 有 `JWT_SECRET`，并检查数据库密码是否与已有 PostgreSQL 卷一致。 |
| 访问产物返回 `ARTIFACT_CONTENT_NOT_FOUND` | 产物元数据存在但共享 Worker 卷缺少文件；核对 `forge-worker-data` 卷、`FORGE_ARTIFACT_ROOT=/data/artifacts` 和 Worker 日志。 |
| 导出任务失败并提示无法读取图像尺寸 | 上传文件不是有效的受支持图像，或共享卷中的原图已损坏；通过图像预览接口确认文件可读后重新上传。 |
| 模型上传返回 `413` | 文件超过 API 当前 512 MB 单文件限制；使用更小权重、拆分 OpenVINO 文件，或在受控环境调整 API `bodyLimit` 后重建镜像。 |
| 构建 Worker 时拉取依赖失败 | 该镜像需要访问 NodeSource、PyPI 和 PyTorch 索引；在隔离网络中预置镜像/包缓存或使用内部镜像仓库。 |
| MinIO 控制台无法访问 | 默认只监听部署机 `127.0.0.1:19001`；使用 SSH 隧道，或仅在受控内网临时修改 `MINIO_CONSOLE_BIND` 后重启 MinIO。 |

## 9. 已知交付边界

- Compose 已启动 MinIO，但当前 Worker 产物使用共享 Docker 卷，尚未实现 S3 上传。备份时必须同时备份 `forge-worker-data`；不能只备份 MinIO。
- YOLOv5u/YOLOv8、SegFormer/U-Net/DeepLabV3+、HRNet/HigherHRNet 已接入真实训练和格式转换。仓库提供 `PYTHONPATH=worker python3 -m forge_worker.acceptance_smoke` 隔离验收；它使用临时图像完成反向传播、TorchScript 加载和 ONNX 校验，不会写入业务数据库。
- SDXL LoRA/DreamBooth LoRA 已实现真实 GPU 训练和融合转换路径，但当前 CPU 部署无法完成 T4 运行验收；正式启用前必须在目标 T4 主机上使用已批准的 Base 模型完成显存、耗时和产物推理验收。TensorRT 同样必须在目标 NVIDIA 运行时验收。
- 当前镜像使用 Vite preview 托管 Web，适合内网首版。需要高可用、TLS、审计留存、外部访问或多节点 GPU 时，应在前置反向代理、镜像仓库、备份监控和 Kubernetes/编排方案中扩展。
