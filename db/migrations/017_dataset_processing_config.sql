ALTER TABLE datasets ADD COLUMN IF NOT EXISTS processing_config JSONB NOT NULL DEFAULT '{"segmentSize":100,"extractionStrategy":"keyframe","frameStep":1,"imageQuality":95}'::jsonb;
ALTER TABLE processing_runs ADD COLUMN IF NOT EXISTS segment_size INTEGER NOT NULL DEFAULT 100;
ALTER TABLE processing_runs ADD COLUMN IF NOT EXISTS frame_step INTEGER;
ALTER TABLE processing_runs ADD COLUMN IF NOT EXISTS start_frame INTEGER;
ALTER TABLE processing_runs ADD COLUMN IF NOT EXISTS end_frame INTEGER;
ALTER TABLE processing_runs ADD COLUMN IF NOT EXISTS image_quality INTEGER NOT NULL DEFAULT 95;
ALTER TABLE annotation_segments DROP CONSTRAINT IF EXISTS annotation_segments_source_asset_id_fkey;
ALTER TABLE annotation_segments ALTER COLUMN source_asset_id DROP NOT NULL;
ALTER TABLE annotation_segments ADD CONSTRAINT annotation_segments_source_asset_id_fkey FOREIGN KEY (source_asset_id) REFERENCES source_assets(id) ON DELETE CASCADE;
