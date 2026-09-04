---
status: accepted
---

# 自研 CVAT 风格标注工作台

平台保留 React 前端和自身训练/审核流程，不直接嵌入完整 CVAT 或复用 CVAT 数据库；内部采用 `Label / Attribute / Shape / Track` 模型，并提供限定范围的 CVAT JSON/XML 导入导出。这样可以获得 CVAT 的高价值交互，同时保持任务领取、审核、训练快照和权限模型的一致性，避免引入独立 CVAT 服务、用户同步和双系统状态一致性成本。

