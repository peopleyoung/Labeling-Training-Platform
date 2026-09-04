ALTER TABLE processing_runs ADD COLUMN IF NOT EXISTS overlap_size INTEGER NOT NULL DEFAULT 0;
ALTER TABLE processing_runs ADD COLUMN IF NOT EXISTS block_size INTEGER;
ALTER TABLE processing_runs ADD COLUMN IF NOT EXISTS use_zip_blocks BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE processing_runs ADD COLUMN IF NOT EXISTS z_order BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE datasets
SET processing_config = jsonb_strip_nulls(jsonb_build_object(
  'extractionStrategy', 'frame_step',
  'frameStep', GREATEST(COALESCE((processing_config->>'frameStep')::integer, 1), 1),
  'startFrame', NULLIF(processing_config->>'startFrame', '')::integer,
  'endFrame', NULLIF(processing_config->>'endFrame', '')::integer,
  'segmentSize', GREATEST(COALESCE((processing_config->>'segmentSize')::integer, 100), 1),
  'imageQuality', LEAST(GREATEST(COALESCE((processing_config->>'imageQuality')::integer, 95), 1), 100),
  'overlapSize', GREATEST(COALESCE((processing_config->>'overlapSize')::integer, 0), 0),
  'blockSize', NULLIF(processing_config->>'blockSize', '')::integer,
  'useZipBlocks', COALESCE((processing_config->>'useZipBlocks')::boolean, FALSE),
  'zOrder', COALESCE((processing_config->>'zOrder')::boolean, FALSE)
))
WHERE processing_config IS NOT NULL;
