---
status: accepted
---

# 重建标注领域模型而不兼容旧数据

由于需求从单图片标注扩展到图片包、视频帧、处理批次、Segment、Job、Track、审核快照和训练快照，平台采用新 Schema，不兼容现有业务数据；图片和视频统一建模为资源、处理批次、Segment 和 Job，以避免继续扩展旧的 `dataset_images + annotation_documents` 简化模型。

