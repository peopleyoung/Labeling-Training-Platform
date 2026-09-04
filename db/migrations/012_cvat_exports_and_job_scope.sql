ALTER TABLE export_tasks ADD COLUMN IF NOT EXISTS job_ids JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE export_tasks DROP CONSTRAINT IF EXISTS export_tasks_format_check;
ALTER TABLE export_tasks ADD CONSTRAINT export_tasks_format_check
  CHECK (format IN ('YOLO', 'COCO', 'VOC', 'COCO_SEGMENTATION', 'PNG_MASK', 'COCO_KEYPOINTS', 'IMAGE_FOLDER', 'CVAT_JSON', 'CVAT_XML'));
