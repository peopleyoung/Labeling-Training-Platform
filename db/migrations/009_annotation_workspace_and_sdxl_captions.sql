ALTER TABLE annotation_documents
  ADD COLUMN IF NOT EXISTS captions JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS image_attributes JSONB NOT NULL DEFAULT '{"includeInSdxl":false,"tags":[]}'::jsonb;

ALTER TABLE annotation_documents
  DROP CONSTRAINT IF EXISTS annotation_documents_captions_array,
  ADD CONSTRAINT annotation_documents_captions_array CHECK (jsonb_typeof(captions) = 'array'),
  DROP CONSTRAINT IF EXISTS annotation_documents_image_attributes_object,
  ADD CONSTRAINT annotation_documents_image_attributes_object CHECK (jsonb_typeof(image_attributes) = 'object');

ALTER TABLE export_tasks DROP CONSTRAINT IF EXISTS export_tasks_format_check;
ALTER TABLE export_tasks ADD CONSTRAINT export_tasks_format_check
  CHECK (format IN ('YOLO', 'COCO', 'VOC', 'COCO_SEGMENTATION', 'PNG_MASK', 'COCO_KEYPOINTS', 'IMAGE_FOLDER'));
