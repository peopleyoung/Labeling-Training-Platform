# Forge AI 工业质检模型训练平台

面向工业质检场景的单租户训练平台，包含 React 工作台、Fastify API、PostgreSQL、Redis/BullMQ、CPU 导出/计算 Worker、可选 GPU Worker 和本地开发用 MinIO。

## 部署

完整的企业内网 Docker Compose 部署、GPU 前置条件、环境变量、迁移、验证、备份恢复、升级和故障排查见 [部署说明](docs/DEPLOYMENT.md)。日常的数据导入、标注审核、训练、模型转换和部署产物使用见 [用户使用说明](docs/USER_GUIDE.md)。

最小启动流程：

```bash
cp .env.example .env
# 修改 .env 中所有密码、JWT_SECRET，以及内网访问时的 CORS_ORIGIN / VITE_API_BASE_URL
docker compose up -d --build
```

上述命令适用于无显卡主机：数据集、标注、导出、模型上传、真实 YOLOv5/YOLOv8、SegFormer/U-Net/DeepLabV3+、HRNet/HigherHRNet CPU 训练，以及 FP32 ONNX、TorchScript、OpenVINO 转换均可用。具备 NVIDIA GPU 时，在 `.env` 设置 `FORGE_GPU_ENABLED=true`，并使用 `docker compose --profile gpu up -d --build` 启动 GPU Worker，以开放 TensorRT、GPU 训练和 SDXL LoRA 训练/转换能力。

浏览器访问 `http://<服务器地址>:5174/`。首次启动只会创建默认工作空间和一个由环境变量指定的管理员账号，业务数据保持为空，详见部署说明。

## 本地运行

```bash
npm install
npm run dev
```

默认开发地址为 `http://localhost:5173/`。需要指定端口时：

```bash
npm run dev -- --port 4173
```

## 主要页面

- `/`：工作台、训练运行、资源与数据准备度
- `/datasets`：任务无关的工业质检数据集、标注进度和七种标准标注格式导出
- `/annotate/:datasetId?image=:imageId`：矩形、多边形、线段/折线、椭圆、关键点、骨架与 SDXL Caption 标注工作台；管理员/工程师可使用 `mode=review` 进入只读审核
- `/training`：训练任务列表与状态筛选
- `/training/new`：目标检测、语义分割、关键点检测和 SDXL 四步训练向导
- `/models`：模型版本、指标、血缘与部署格式
- `/conversions`：ONNX、TensorRT、TorchScript、OpenVINO 转换配置与任务

## 质量检查

```bash
npm run typecheck
npm run test
npm run build
npm run test:e2e
```

Playwright 会自动启动开发服务器。

## 当前运行时边界

- API、数据集、图像、标注 revision、训练事件、训练/转换/导出任务、模型上传和产物元数据由 PostgreSQL 持久化；Redis 只负责 BullMQ 调度。
- 标注支持数据集级统一提交、图像级审核。提交后的图像在审核完成前锁定；管理员/工程师可逐张或批量通过/驳回，驳回必须填写原因。只有全部图像审核通过的数据集才允许训练与正式导出。
- 导出由默认 `export-worker` 消费；CPU YOLO 训练和 FP32 ONNX/TorchScript/OpenVINO 转换由默认 `cpu-worker` 消费；GPU 训练与 TensorRT 转换由可选 GPU Worker 消费。API 按能力将任务路由到独立队列。Worker 产物与预训练权重缓存保存在共享 `/data` 卷，API 通过受鉴权下载路由提供文件；MinIO 容器已包含在开发部署中，但当前产物路径尚未上传到 S3。
- 新建数据集不绑定任务类型。训练时先选择目标检测、语义分割、关键点或 SDXL，再选择该任务兼容的数据格式；选择值会持久化并控制 Worker 的实际数据物化和加载路径。
- 数据集导出产物为 ZIP，且只包含所选格式可表达并已标注审核的图片。目标检测支持 YOLO、COCO、VOC；语义分割支持 COCO Segmentation、PNG Mask；关键点支持 COCO Keypoints（首版每张图一个实例）；SDXL 支持带 `metadata.jsonl` 的 Image Folder。
- YOLOv5u/YOLOv8 使用 Ultralytics 训练器。分割执行器将矩形/多边形标注栅格化后训练 SegFormer、U-Net 或 DeepLabV3+；关键点执行器将编号关键点生成高斯热图后训练 HRNet/HigherHRNet。SegFormer MiT、U-Net/DeepLabV3+ ResNet 编码器和 HRNet 主干均可选择官方预训练权重或从头训练。三类视觉任务均登记真实指标和可加载 TorchScript，支持 ONNX、TorchScript、OpenVINO，并在 GPU Worker 上支持 TensorRT。
- SDXL 标注按图保存人工主 Caption、语言、标签、是否纳入训练和可选裁剪区域。训练读取审核后的 Image Folder `metadata.jsonl`，使用管理员预置的 SDXL Base Diffusers 目录进行真实 UNet LoRA 或 DreamBooth LoRA 微调，产出 SafeTensors；转换会先融合 LoRA，再导出 SDXL UNet 组件。SDXL 训练和转换均要求 CUDA，不在 CPU 模式伪造产物；ControlNet 暂不开放，因为平台尚无成对条件图数据契约。
- Ultralytics/YOLO 的 AGPL-3.0 合规文件尚未随本仓库交付。对外分发前必须补齐许可证、第三方声明和源码获取说明。
