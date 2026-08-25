ALTER TABLE training_jobs
  DROP CONSTRAINT IF EXISTS training_jobs_type_check,
  ADD CONSTRAINT training_jobs_type_check CHECK (type IN ('detection', 'segmentation', 'instance_segmentation', 'keypoint', 'sdxl'));

ALTER TABLE model_versions
  DROP CONSTRAINT IF EXISTS model_versions_task_check,
  ADD CONSTRAINT model_versions_task_check CHECK (task IN ('detection', 'segmentation', 'instance_segmentation', 'keypoint', 'sdxl')),
  ADD COLUMN IF NOT EXISTS architecture_variant TEXT NOT NULL DEFAULT 'standard' CHECK (architecture_variant IN ('standard', 'rk_compatible')),
  ADD COLUMN IF NOT EXISTS target_family TEXT,
  ADD COLUMN IF NOT EXISTS rk_compatibility_status TEXT NOT NULL DEFAULT 'not_reviewed' CHECK (rk_compatibility_status IN ('not_reviewed', 'standard_only', 'rk_structure_ready', 'onnx_validated', 'device_validated')),
  ADD COLUMN IF NOT EXISTS output_protocol TEXT NOT NULL DEFAULT 'segmentation_logits';

ALTER TABLE export_tasks DROP CONSTRAINT IF EXISTS export_tasks_format_check;
ALTER TABLE export_tasks ADD CONSTRAINT export_tasks_format_check
  CHECK (format IN ('YOLO', 'COCO', 'VOC', 'COCO_SEGMENTATION', 'PNG_MASK', 'YOLO_SEG', 'COCO_KEYPOINTS', 'IMAGE_FOLDER'));
