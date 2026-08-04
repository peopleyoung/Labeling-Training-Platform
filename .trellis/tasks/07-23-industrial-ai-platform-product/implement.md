# 工业质检训练平台产品化 - 实施计划

## Phase A: Product Foundation

- [ ] 补充 AGPL-3.0 许可证、第三方依赖清单和产品配置模板。
- [ ] 建立 `shared` API 契约、错误码、领域枚举和模型目录。
- [ ] 建立 PostgreSQL migration、seed 数据和 repository 接口。
- [ ] 建立 Fastify API：健康检查、登录、当前用户、数据集、标注、训练、模型、转换和产物路由。
- [ ] 建立 Argon2id/JWT 鉴权、角色权限和审计中间件。

## Phase B: Task Runtime

- [ ] 建立 Redis/BullMQ 任务队列、状态机和事件表。
- [ ] 建立 Python Worker 基础镜像、T4 GPU 资源发现和结构化日志协议。
- [ ] 接入 YOLOv5/YOLOv8、SegFormer/U-Net/DeepLabV3+、HRNet/HigherHRNet、SDXL 三种微调模式执行器。
- [ ] 接入 COCO/VOC/语义分割导出执行器和四类转换执行器。
- [x] 接入已标注目标检测数据物化、YOLOv5/YOLOv8 真实 CPU/GPU 训练、`best.pt` 与 mAP 登记。
- [x] 接入 YOLO ONNX/TorchScript/OpenVINO/TensorRT 真实导出路径；CPU 开放 FP32 非 TensorRT 格式。
- [x] 接入分割/关键点标注清单、真实训练、TorchScript 产物和通用部署转换。
- [x] SegFormer/U-Net/DeepLabV3+、HRNet/HigherHRNet 支持缓存优先的官方预训练骨干、离线预取和真实训练/转换验收。
- [x] 接入 SDXL GPU LoRA 训练、基础模型缓存契约和适用格式转换。
- [ ] 产物上传 MinIO，登记 hash、大小、来源和下载权限。

## Phase C: Frontend Productization

- [ ] 添加登录页、会话恢复、角色导航和权限禁用态。
- [ ] 用 `apiClient` 替换 `AppContext` 中任务创建和列表 mock，提供 loading/error/empty 状态。
- [ ] 标注保存/恢复接入 revision 乐观锁，导出、训练、转换改为 API 任务。
- [x] 任务详情增加实时轮询、Epoch 指标、资源遥测、日志、失败原因、取消和基于持久化原配置的重新训练。
- [x] 训练列表和详情增加终态任务删除，清理队列记录并级联任务日志/指标/遥测，保留模型与制品。
- [ ] 保持现有科技蓝工作台和核心端到端流程。

## Phase E: Task-Neutral Dataset Formats

- [x] 新增共享 `DataFormat`、任务兼容矩阵及 `TrainingDraft.dataFormat`，移除数据集创建请求中的必填任务类型。
- [x] 增加 migration 008：数据集类型可空、历史数据保留、导出格式约束扩展并迁移 `SEGMENTATION -> PNG_MASK`。
- [x] 更新内存/PostgreSQL repository、API 校验、审计和重试配置，删除数据集类型训练门禁。
- [x] 抽取标准格式物化与验证层，补齐 YOLO、COCO、VOC、COCO Segmentation、PNG Mask、单实例 COCO Keypoints 导出。
- [x] 为每种训练格式实现读回与框架原生数据转换，确保选择值真实控制 Worker 路径。
- [x] 更新数据集创建/列表/导出 UI 和训练向导/详情 UI，兼容旧数据集记录。
- [x] 补充 migration、契约、API、导出器、训练数据加载、前端和 Playwright 回归测试。
- [x] 运行 typecheck、全部测试、真实训练 smoke、生产构建和 Compose 部署验证。

## Phase D: Delivery And Verification

- [ ] 添加 Docker Compose、GPU Worker override、环境变量模板和启动脚本。
- [ ] 添加 API 单元/集成测试、权限测试、migration smoke test 和 Worker fake executor 测试。
- [ ] 运行前端 typecheck/test/build/e2e 及服务端 typecheck/test。
- [x] 复核任务失败可重试行为：保留原失败记录，以新任务 ID 重新校验配置并入队，记录来源事件与审计。
- [ ] 复核 T4 16GB 默认配置、AGPL 通知和备份恢复。

## Phase F: Annotation And Observability Upgrade

- [x] 扩展共享标注契约、Zod 校验、repository 与 migration 009，保存 Caption 和图像级属性并兼容旧请求。
- [x] 为线段/折线、椭圆、骨架及其移动/控制点编辑增加纯几何工具和测试。
- [x] 升级标注工作台工具栏、对象属性、锁定/隐藏和 SDXL Caption 面板。
- [x] 生成标准 Image Folder `metadata.jsonl`，训练物化和 SDXL Runner 真实读取人工 Caption。
- [x] 将训练指标图升级为左右纵轴、数值刻度、交互 Tooltip 和系列显隐。
- [x] 扩充 API、前端组件、导出/训练数据和 Python 数据加载测试，并完成桌面/窄屏截图检查。

## Phase G: Asset Pagination And Model Versioning

- [x] 提供统一分页栏，在数据集、训练任务和模型列表支持每页 10/20/50 条。
- [x] 将模型版本加入训练向导、共享契约、API 校验、任务配置、任务详情和 Worker 模型登记。
- [x] 模型仓库以训练任务名称或“人工上传”展示来源，不直接显示来源任务 ID。
- [x] 增加分页、版本默认值、版本冲突和模型来源显示回归测试。

## Phase H: Conversion Task Pagination And Deletion

- [x] 转换任务列表接入统一分页栏，支持每页 10/20/50 条并在搜索变化时回到第一页。
- [x] 增加转换任务 Repository 事务删除、CPU/GPU 队列清理、产物目录删除和审计记录。
- [x] 增加终态任务删除确认、活动任务保护、释放空间提示和权限控制。
- [x] 补充 API 与页面回归测试，并完成类型检查和构建验证。

## Validation Commands

```bash
npm run typecheck
npm run test
npm run build
npm run test:e2e
npm run typecheck:server
npm run test:server
docker compose config
```

## Risk And Rollback Points

- 先稳定 API/repository 契约，再接 UI，避免页面继续复制服务端状态。
- Worker 只通过队列和产物协议与 API 通信；任何模型框架安装问题不应拖垮 API。
- T4 上的 SDXL 训练极易 OOM，默认限制 batch=1、FP16、gradient accumulation，并允许任务在资源校验阶段拒绝不可行配置。
- AGPL 合规文件和模型权重来源必须在交付镜像生成前检查；缺失时阻止 release 构建。
