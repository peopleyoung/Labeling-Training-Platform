# 数据中心发布记录

## 发布结果

- 2026-09-08 UTC 发布，Web `http://localhost:5173`，API `http://localhost:4000/api/v1`，端口未修改。
- API/Web 健康检查通过，CPU/export Worker 正常启动；实际管理员登录、全局目录、空树及数据集接口返回 200。
- 当前目录包含五个初始大类，无预置业务任务。管理员先维护业务任务，再从任务中心创建数据集。
- 任务类型目录入口位于“系统管理 → 用户与角色”板块下方；系统管理页右上角不再展示“标注审核统计”入口，左侧栏入口和统计功能完整保留。
- 图形界面在 1440px 和 390px 验证树、详情、目录，未出现页面横向溢出或浏览器异常；上线后用真实登录再次验证空树、目录及新增任务窗口，未创建测试业务记录。

## 历史清理与恢复

- 删除数据集 `ceshi2`（`dataset-cd7c6eb7-6a6f-4401-bd68-de3abd05e623`）和 `cs`（`dataset-eefae236-05aa-4157-9eab-3d471924d15e`）。
- 同时删除图片、标注文档、处理记录以及关联的 2 个训练任务、2 个模型、1 个转换任务、3 个制品注册及对应队列记录。
- 5 个受管目录已移至宿主机 `data/catalog-reset-recovery-1788829851384/`（约 234 MB），不再从应用制品目录对外提供访问。
- 最终停机数据库备份：`data/catalog-stopped-before-reset-20260908.dump`；预演前备份：`data/catalog-before-reset-20260908.dump`。备份权限为 600，不提交 Git。
- 清理审计：`audit_logs.action = 'dataset.catalog_reset'`，metadata 含逐目录 source/destination。再次执行返回 `alreadyCompleted: true`，不会删除新数据。
- 恢复需要停 API/Worker，把最终备份恢复到经确认的恢复数据库，并根据审计恢复文件到原位置，使用发布前应用版本。不得直接覆盖已有新数据；上线后若已产生业务数据，应先另行备份并制定合并恢复方案。

## 镜像与验证

- API、Web、export-worker 由 Compose 构建并部署。
- CPU Worker 无依赖变更；完整构建下载 PyTorch 长时间无进展后中止。用已运行镜像的依赖构建发布层：`Dockerfile.cpu-release`，基础镜像本地标签 `labeling-training-platform-cpu-runtime:catalog-20260908`（原镜像 `06ae3498a5d8bf1a7729eaab0542b1a488360d06c9b9eeb96496d445c4073ca6`）。仅覆盖 package、TS 配置、server/shared；运行时确认 PyTorch `2.4.1+cpu`。
- `npm run typecheck`、`npm run typecheck:server`、`npm run build` 通过。
- 常规 Vitest：173 通过，5 个环境专用测试跳过；其中 4 个 PostgreSQL 测试已在临时数据库单独通过，余下 ffmpeg 集成测试本轮未启用。
- 最终目录更新默认值修复后：API、目录与数据中心 38 项测试再次通过，生产镜像重新构建。
- `VITE_API_ENABLED=true npx playwright test e2e/data-center.spec.ts`：2 通过。
- 既有构建提示：前端主包超过 500 KB；依赖安装报告 9 个审计问题。本次没有更改依赖，不在该功能内进行依赖升级。
- 代码未提交或推送，任务尚未归档。
