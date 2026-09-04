ALTER TABLE processing_runs DROP CONSTRAINT IF EXISTS processing_runs_extraction_strategy_check;
ALTER TABLE processing_runs ADD CONSTRAINT processing_runs_extraction_strategy_check CHECK (extraction_strategy IN ('fps', 'interval_ms', 'frame_step', 'keyframe'));
