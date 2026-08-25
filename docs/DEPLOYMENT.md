# 工业视觉训练平台部署说明

本文档说明当前项目的部署结构、环境准备、启动方式、模型准备、数据持久化和日常运维。系统面向企业内网的单租户一体化部署，默认在一台 Linux 服务器上通过 Docker Compose 运行。

## 1. 部署结构

系统由以下容器组成：

| 服务 | Compose 服务名 | 作用 | 默认对外端口 |
| --- | --- | --- | --- |
| Web | `web` | 前端页面 | `5174` |
| API | `api` | 认证、数据、标注、训练和转换接口 | `4000` |
| PostgreSQL | `postgres` | 业务数据和任务状态 | 仅容器网络 |
| Redis | `redis` | 训练、导出和转换任务队列 | 仅容器网络 |
| MinIO | `minio` | 对象存储基础服务 | S3 端口仅容器网络，控制台默认 `127.0.0.1:19001` |
| 导出 Worker | `export-worker` | 数据集导出 | 无 |
| CPU Worker | `cpu-worker` | CPU 训练及 CPU 模型转换 | 无 |
| GPU Worker | `worker` | GPU 训练及 GPU 模型转换 | 无，按 `gpu` profile 启动 |

当前业务图片、导出包、训练产物、模型和转换产物保存在 `forge-worker-data` Docker 卷的 `/data/artifacts` 下。模型缓存位于同一卷的 `/data/model-cache`。MinIO 作为当前部署组成部分运行，但业务产物不直接写入 MinIO，因此备份时必须同时备份 PostgreSQL、`forge-worker-data` 和 MinIO 数据卷。

## 2. 运行条件

### 2.1 通用条件

- 64 位 Linux 服务器
- Docker Engine 24 或更高版本
- Docker Compose v2
- 可访问项目依赖源，或已准备内部 npm、PyPI、PyTorch 和模型缓存
- 建议至少 8 个 CPU 核心、16 GB 内存和 100 GB 可用磁盘空间
- GPU 训练建议额外预留模型权重、训练数据、中间检查点和转换产物所需空间

检查 Docker：

```bash
docker version
docker compose version
```

### 2.2 GPU 条件

GPU 模式需要：

- NVIDIA GPU
- 与 CUDA 12.1 容器兼容的 NVIDIA 驱动
- NVIDIA Container Toolkit
- 当前 Compose GPU 服务默认申请 2 张 NVIDIA GPU

检查宿主机和容器 GPU：

```bash
nvidia-smi
docker run --rm --gpus all \
  nvidia/cuda:12.1.1-cudnn8-runtime-ubuntu22.04 \
  nvidia-smi
```

没有 GPU 时使用 CPU 模式。CPU 模式能够执行真实训练及 FP32 模型转换，但不支持 SDXL 训练、FP16 转换和 TensorRT 转换。

## 3. 准备配置

进入项目目录，复制环境变量模板：

```bash
cd /path/to/codex-train-server
cp .env.example .env
```

编辑 `.env`，至少修改数据库密码、MinIO 密码、JWT 密钥和管理员密码：

```dotenv
COMPOSE_PROJECT_NAME=forge-ai

POSTGRES_PASSWORD=请设置强密码
MINIO_ROOT_USER=forge-minio
MINIO_ROOT_PASSWORD=请设置强密码
JWT_SECRET=请设置长度足够的随机密钥

BOOTSTRAP_ADMIN_USERNAME=admin
BOOTSTRAP_ADMIN_PASSWORD=请设置至少12位的强密码
BOOTSTRAP_ADMIN_DISPLAY_NAME=平台管理员
ALLOW_WEAK_BOOTSTRAP_PASSWORD=false

FORGE_GPU_ENABLED=false
FORGE_CPU_TRAINING_ENABLED=true
FORGE_CPU_ONNX_ENABLED=true
FORGE_PRETRAINED_OFFLINE=false
HF_ENDPOINT=https://huggingface.co
FORGE_SDXL_BASE_MODEL=/data/model-cache/stable-diffusion-xl-base-1.0

CORS_ORIGIN=http://localhost:5174
VITE_API_BASE_URL=http://localhost:4000/api/v1

WEB_BIND=0.0.0.0
WEB_PORT=5174
API_BIND=0.0.0.0
API_PUBLIC_PORT=4000
MINIO_CONSOLE_BIND=127.0.0.1
MINIO_CONSOLE_PORT=19001
```

配置说明：

| 变量 | 说明 |
| --- | --- |
| `COMPOSE_PROJECT_NAME` | Compose 项目名，也决定默认数据卷名称前缀 |
| `BOOTSTRAP_ADMIN_*` | 系统初始化时创建的管理员账号 |
| `ALLOW_WEAK_BOOTSTRAP_PASSWORD` | 是否允许低于 12 位的管理员密码；生产环境保持 `false` |
| `FORGE_GPU_ENABLED` | API 是否把训练和模型转换任务投递到 GPU 队列 |
| `FORGE_CPU_TRAINING_ENABLED` | 是否允许 CPU 训练 |
| `FORGE_CPU_ONNX_ENABLED` | 是否允许 CPU ONNX 转换 |
| `FORGE_PRETRAINED_OFFLINE` | 是否只从本地缓存加载预训练模型 |
| `HF_ENDPOINT` | Hugging Face 模型源或企业内部镜像地址 |
| `FORGE_SDXL_BASE_MODEL` | SDXL Diffusers 基础模型目录 |
| `CORS_ORIGIN` | 浏览器实际访问 Web 的 Origin，必须包含协议和端口 |
| `VITE_API_BASE_URL` | 浏览器访问 API 的完整基础地址，在 Web 镜像构建时写入 |

管理员密码在 `ALLOW_WEAK_BOOTSTRAP_PASSWORD=false` 时至少需要 12 位。初始化参数负责创建账号，不用于覆盖数据库中已经存在的账号密码。

### 3.1 内网地址配置

当用户通过 `http://192.168.10.20:5174` 访问平台，API 使用 `4000` 端口时，应配置：

```dotenv
CORS_ORIGIN=http://192.168.10.20:5174
VITE_API_BASE_URL=http://192.168.10.20:4000/api/v1
```

`VITE_API_BASE_URL` 会写入前端构建产物。修改该变量后必须重新构建 `web`；修改 `CORS_ORIGIN` 后必须重新创建 `api`。

### 3.2 端口冲突处理

先检查端口占用：

```bash
ss -ltnp | grep -E ':(5174|4000|19001)\b'
```

如有冲突，在 `.env` 中选择未占用端口，并同步修改浏览器地址：

```dotenv
WEB_PORT=15174
API_PUBLIC_PORT=14000
MINIO_CONSOLE_PORT=19002
CORS_ORIGIN=http://192.168.10.20:15174
VITE_API_BASE_URL=http://192.168.10.20:14000/api/v1
```

端口修改后重新构建并启动：

```bash
docker compose up -d --build
```

## 4. CPU 模式部署

CPU 模式是默认部署方式，不构建 GPU Worker：

```bash
docker compose config --quiet
docker compose up -d --build
```

查看状态：

```bash
docker compose ps
docker compose logs --tail=100 api web cpu-worker export-worker
```

CPU 模式支持：

- YOLOv5u、YOLOv8 目标检测训练
- YOLOv8-Seg 实例分割训练
- SegFormer、U-Net、DeepLabV3+ 语义分割训练
- YOLOv8-Pose、HRNet、HigherHRNet 关键点训练
- ONNX、TorchScript、OpenVINO FP32 转换

CPU 训练使用部署服务器的 CPU 和内存，不使用访问网页的客户端计算资源。大型数据集和较大模型在 CPU 上训练耗时较长。

## 5. GPU 模式部署

在 `.env` 中启用 GPU：

```dotenv
FORGE_GPU_ENABLED=true
```

构建并启动 GPU profile：

```bash
docker compose --profile gpu config --quiet
docker compose --profile gpu up -d --build
```

确认 GPU Worker 可见 GPU：

```bash
docker compose --profile gpu exec worker nvidia-smi
docker compose --profile gpu logs --tail=100 worker
```

GPU 模式支持全部 CPU 模式能力，并增加：

- FP16 模型转换
- TensorRT 转换
- SDXL LoRA 和 DreamBooth LoRA 训练

GPU 资源使用规则：

- YOLOv5u、YOLOv8、YOLOv8-Seg、YOLOv8-Pose 可按任务配置使用 1 张或 2 张 GPU。
- SegFormer、U-Net、DeepLabV3+、HRNet、HigherHRNet 当前单个任务使用 1 张 GPU。
- SDXL 当前单个任务使用 1 张 GPU。
- CPU Worker 在 GPU 部署中仍会运行，负责系统允许的 CPU 队列任务；训练和转换的默认队列由 `FORGE_GPU_ENABLED` 决定。

## 6. 准备预训练模型

平台支持从在线模型源下载并缓存预训练权重，也支持先准备缓存再切换到离线加载。

### 6.1 下载通用模型

执行统一预取命令：

```bash
docker compose run --rm cpu-worker \
  env PYTHONPATH=/app/worker \
  python3 -m forge_worker.prefetch_models
```

模型保存在 `forge-worker-data` 卷的 `/data/model-cache`。模型源可通过 `HF_ENDPOINT` 指向企业内部镜像。

下载完成后执行模型加载检查：

```bash
docker compose run --rm cpu-worker \
  env PYTHONPATH=/app/worker \
  python3 -m forge_worker.acceptance_smoke --pretrained
```

当服务器不能访问外网时，在缓存准备完成后设置：

```dotenv
FORGE_PRETRAINED_OFFLINE=true
```

然后重新创建 Worker：

```bash
docker compose up -d --force-recreate cpu-worker export-worker
docker compose --profile gpu up -d --force-recreate worker
```

未启用 GPU profile 时不需要执行第二条命令。

### 6.2 准备 SDXL 基础模型

SDXL 训练要求 GPU，并要求 `FORGE_SDXL_BASE_MODEL` 指向完整的 Diffusers 模型目录。目录至少应包含：

- `model_index.json`
- `tokenizer`、`tokenizer_2`
- `text_encoder`、`text_encoder_2`
- `vae`
- `unet`
- `scheduler`

将宿主机模型目录复制到持久化卷：

```bash
docker run --rm \
  -v forge-ai_forge-worker-data:/data \
  -v /opt/internal-models/stable-diffusion-xl-base-1.0:/source:ro \
  alpine sh -c 'mkdir -p /data/model-cache/stable-diffusion-xl-base-1.0 && cp -a /source/. /data/model-cache/stable-diffusion-xl-base-1.0/'
```

如果修改了 `COMPOSE_PROJECT_NAME`，先通过 `docker volume ls` 确认数据卷名称，再替换命令中的 `forge-ai_forge-worker-data`。

确认 Worker 能读取模型：

```bash
docker compose --profile gpu exec worker \
  test -f /data/model-cache/stable-diffusion-xl-base-1.0/model_index.json
```

## 7. 部署验证

### 7.1 服务健康检查

```bash
curl -fsS http://127.0.0.1:4000/api/v1/health
curl -fsS http://127.0.0.1:4000/api/v1/ready
curl -fsS http://127.0.0.1:4000/api/v1/capabilities
```

使用自定义 API 端口时替换 `4000`。

检查基础服务：

```bash
docker compose exec redis redis-cli ping
docker compose exec postgres \
  psql -U forge -d forge -c 'SELECT username, role FROM users ORDER BY username;'
```

### 7.2 页面验证

浏览器打开：

```text
http://服务器地址:WEB_PORT
```

使用 `.env` 中的 `BOOTSTRAP_ADMIN_USERNAME` 和 `BOOTSTRAP_ADMIN_PASSWORD` 登录。依次确认：

1. 工作台可以加载统计数据和近期活动。
2. 数据中心可以创建数据集并上传图片。
3. 标注页可以打开图片并保存标注草稿。
4. 训练中心可以读取能力信息并创建符合当前计算环境的任务。
5. 模型仓库和转换中心可以正常加载分页列表。

## 8. 当前模型与转换能力

| 任务 | 当前模型 |
| --- | --- |
| 目标检测 | YOLOv5u n/s/m/l/x、YOLOv8 n/s/m/l/x |
| 实例分割 | YOLOv8-Seg n/s/m/l/x |
| 语义分割 | SegFormer B0-B5、U-Net、DeepLabV3+ ResNet50/101、MobileNetV2、MobileNetV2 RK、MobileNetV3-Large |
| 关键点检测 | YOLOv8-Pose n/s/m/l/x、HRNet W32/W48、HigherHRNet W32/W48 |
| 生成模型 | SDXL 1.0 LoRA、SDXL 1.0 DreamBooth LoRA |

转换目标：

| 格式 | CPU | GPU | 说明 |
| --- | --- | --- | --- |
| ONNX | FP32 | FP32/FP16 | 通用交换格式 |
| TorchScript | FP32 | FP32/FP16 | PyTorch 部署 |
| OpenVINO | FP32 | FP32/FP16 | Intel 设备部署 |
| TensorRT | 不支持 | FP32/FP16 | NVIDIA GPU 部署 |

标记为“适用 RK”的模型可导出固定输入、静态 batch、NCHW、opset 12 或 13 的 ONNX。平台不生成 RKNN 文件，也不内置 RKNN Toolkit。YOLO 检测、分割、关键点后处理保持在模型外部，由目标设备侧完成 NMS、掩码或关键点解码。

## 9. 数据持久化与磁盘清理

默认数据卷：

| 数据卷 | 内容 |
| --- | --- |
| `forge-postgres` | 用户、数据集、标注、任务、审计记录 |
| `forge-redis` | 队列状态 |
| `forge-minio` | MinIO 数据 |
| `forge-worker-data` | 图片、导出包、训练产物、模型、转换产物、模型缓存 |

查看数据卷和磁盘使用：

```bash
docker volume ls | grep forge
docker system df -v
docker compose exec -T cpu-worker du -h -d 2 /data | sort -h
```

在页面删除数据集、训练任务、模型或转换任务时，系统会删除其数据库记录和对应业务产物。正在运行的任务需要先取消并等待进入终态。

清理数据库中已经不存在的孤立业务文件，先预览：

```bash
docker compose exec -T api npm run artifacts:cleanup
```

确认清单后执行：

```bash
docker compose exec -T api npm run artifacts:cleanup -- --execute
```

该命令只处理 `/data/artifacts` 中可确认的孤立产物，不清理 `/data/model-cache`，也不会删除活动任务正在使用的文件。

日常停止服务使用：

```bash
docker compose down
```

不要使用 `docker compose down -v`，该命令会删除持久化数据卷。

## 10. 备份

备份前确认磁盘空间充足，并尽量安排在没有上传、标注保存、训练产物写入和模型转换的维护窗口。

创建备份目录并备份 PostgreSQL：

```bash
mkdir -p backups
docker compose exec -T postgres \
  pg_dump -U forge -d forge -Fc \
  > backups/forge-$(date +%F-%H%M%S).dump
```

备份业务文件和模型缓存：

```bash
docker run --rm \
  -v forge-ai_forge-worker-data:/source:ro \
  -v "$PWD/backups":/backup \
  alpine tar czf /backup/worker-data-$(date +%F-%H%M%S).tgz -C /source .
```

备份 MinIO：

```bash
docker run --rm \
  -v forge-ai_forge-minio:/source:ro \
  -v "$PWD/backups":/backup \
  alpine tar czf /backup/minio-$(date +%F-%H%M%S).tgz -C /source .
```

若 `COMPOSE_PROJECT_NAME` 不是 `forge-ai`，用 `docker volume ls` 查出实际卷名并替换命令。备份完成后检查文件大小，并在独立环境验证备份可读取。恢复会覆盖当前数据，只能在停止写入、确认目标环境和验证备份文件后执行。

## 11. 日常运维命令

查看服务：

```bash
docker compose ps
```

查看日志：

```bash
docker compose logs -f --tail=200 api
docker compose logs -f --tail=200 cpu-worker
docker compose logs -f --tail=200 export-worker
docker compose --profile gpu logs -f --tail=200 worker
```

重启单个服务：

```bash
docker compose restart api
docker compose restart cpu-worker
```

重新构建应用服务：

```bash
docker compose up -d --build api web cpu-worker export-worker
docker compose --profile gpu up -d --build worker
```

查看任务队列：

```bash
docker compose exec redis redis-cli LLEN bull:training:wait
docker compose exec redis redis-cli LLEN bull:conversion:wait
docker compose exec redis redis-cli LLEN bull:export:wait
```

## 12. 故障排查

### 12.1 页面提示 `Failed to fetch`

按顺序检查：

```bash
docker compose ps
curl -v http://127.0.0.1:4000/api/v1/health
docker compose logs --tail=200 api
```

然后确认：

- `VITE_API_BASE_URL` 是客户端可以访问的 API 地址，不是容器内部地址。
- `CORS_ORIGIN` 与浏览器地址栏中的协议、主机和端口完全一致。
- 防火墙允许 Web 和 API 端口。
- 修改 `VITE_API_BASE_URL` 后已经重建 `web`。
- API CORS 允许 `GET`、`POST`、`PUT`、`PATCH`、`DELETE` 和 `OPTIONS`。

### 12.2 数据上传失败

- 只上传 JPEG、PNG 或 WebP 图片。
- 单张图片不能超过 50 MB。
- 检查 `forge-worker-data` 所在磁盘是否已满。
- 查看 `api` 日志中的请求状态和文件写入错误。
- 确认数据集未被删除，当前账号具有 `admin` 或 `engineer` 权限。

### 12.3 任务一直排队

- CPU 模式检查 `cpu-worker`。
- GPU 模式检查 `worker`、`nvidia-smi` 和 `FORGE_GPU_ENABLED`。
- 数据导出检查 `export-worker`。
- 检查 Redis 是否返回 `PONG`。
- 查看相应 Worker 日志中的模型下载、数据格式或显存错误。

### 12.4 GPU Worker 启动失败

- 确认宿主机 `nvidia-smi` 正常。
- 确认 NVIDIA Container Toolkit 已安装。
- 确认容器测试命令能够看到 GPU。
- 当前 Compose 默认申请 2 张 GPU；服务器 GPU 数量不足时，应将 `docker-compose.yml` 中 GPU reservation 的 `count` 调整为实际数量，并同步任务中的 GPU 数量。

### 12.5 预训练模型加载失败

- 在线模式检查 DNS、代理、证书和 `HF_ENDPOINT`。
- 离线模式确认模型已经存在于 `/data/model-cache`。
- 检查模型目录是否完整，文件是否可由容器读取。
- 查看 Worker 日志中的具体模型名称和缺失文件。

### 12.6 转换失败

- TensorRT 和 FP16 转换必须使用 GPU Worker。
- CPU 只能执行支持的 FP32 转换。
- 自定义 PyTorch `state_dict` 不能自动推断网络结构，应上传 ONNX、TorchScript，或使用平台训练生成且可识别的模型。
- SDXL 转换要求完整基础模型和 LoRA 产物，且只导出融合后的 UNet 组件。
- 适用 RK 的 ONNX 必须使用固定输入尺寸和静态 batch 1。

## 13. 安全建议

- 仅在受控企业内网开放 Web 和 API 端口。
- PostgreSQL、Redis 和 MinIO S3 API 保持仅容器网络访问。
- MinIO 控制台默认绑定 `127.0.0.1`；需要远程管理时通过堡垒机或 SSH 隧道访问。
- 为 PostgreSQL、MinIO、JWT 和管理员账号分别使用强随机密钥。
- 定期备份 PostgreSQL 和两个文件数据卷，并验证备份可用性。
- 限制 Docker 管理权限；能够访问 Docker 的账号等同于拥有宿主机高权限。
- 通过防火墙限制来源网段，并在入口代理配置 HTTPS 时同步调整 `CORS_ORIGIN` 和 `VITE_API_BASE_URL`。
