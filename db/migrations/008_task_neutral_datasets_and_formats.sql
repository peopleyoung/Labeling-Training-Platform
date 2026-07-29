ALTER TABLE datasets ALTER COLUMN type DROP NOT NULL;

ALTER TABLE datasets DROP CONSTRAINT IF EXISTS datasets_type_check;
ALTER TABLE datasets ADD CONSTRAINT datasets_type_check
  CHECK (type IS NULL OR type IN ('目标检测', '语义分割', '关键点'));

UPDATE export_tasks SET format = 'PNG_MASK' WHERE format = 'SEGMENTATION';
ALTER TABLE export_tasks DROP CONSTRAINT IF EXISTS export_tasks_format_check;
ALTER TABLE export_tasks ADD CONSTRAINT export_tasks_format_check
  CHECK (format IN ('YOLO', 'COCO', 'VOC', 'COCO_SEGMENTATION', 'PNG_MASK', 'COCO_KEYPOINTS'));

UPDATE training_jobs
SET config = jsonb_set(
  COALESCE(config, '{}'::jsonb),
  '{dataFormat}',
  to_jsonb(CASE type
    WHEN 'detection' THEN 'YOLO'
    WHEN 'segmentation' THEN 'PNG_MASK'
    WHEN 'keypoint' THEN 'COCO_KEYPOINTS'
    ELSE 'IMAGE_FOLDER'
  END::text),
  true
)
WHERE config IS NOT NULL AND NOT (config ? 'dataFormat');
