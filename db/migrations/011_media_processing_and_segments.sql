ALTER TABLE source_assets ADD COLUMN IF NOT EXISTS processing_error TEXT;

CREATE TABLE IF NOT EXISTS processing_runs (
  id TEXT PRIMARY KEY,
  dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  source_asset_id TEXT REFERENCES source_assets(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'partial_failed', 'failed', 'cancelled')),
  progress INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  extraction_strategy TEXT CHECK (extraction_strategy IN ('fps', 'interval_ms', 'keyframe')),
  fps NUMERIC,
  interval_ms INTEGER,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE processing_runs ADD COLUMN IF NOT EXISTS source_asset_id TEXT REFERENCES source_assets(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS processing_runs_dataset_created_idx ON processing_runs(dataset_id, created_at DESC);

ALTER TABLE dataset_images
  ADD COLUMN IF NOT EXISTS source_asset_id TEXT REFERENCES source_assets(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS source_relative_path TEXT,
  ADD COLUMN IF NOT EXISTS source_frame_number INTEGER,
  ADD COLUMN IF NOT EXISTS source_timestamp_ms BIGINT,
  ADD COLUMN IF NOT EXISTS extraction_order INTEGER,
  ADD COLUMN IF NOT EXISTS thumbnail_object_key TEXT,
  ADD COLUMN IF NOT EXISTS processing_run_id TEXT REFERENCES processing_runs(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS dataset_images_source_order_idx ON dataset_images(source_asset_id, extraction_order, id);

CREATE TABLE IF NOT EXISTS annotation_segments (
  id TEXT PRIMARY KEY,
  dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  annotation_task_id TEXT NOT NULL REFERENCES annotation_tasks(id) ON DELETE CASCADE,
  source_asset_id TEXT NOT NULL REFERENCES source_assets(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  start_item_id TEXT NOT NULL,
  end_item_id TEXT NOT NULL,
  item_count INTEGER NOT NULL CHECK (item_count > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(annotation_task_id, sequence)
);

CREATE TABLE IF NOT EXISTS annotation_jobs (
  id TEXT PRIMARY KEY,
  dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  annotation_task_id TEXT NOT NULL REFERENCES annotation_tasks(id) ON DELETE CASCADE,
  segment_id TEXT NOT NULL UNIQUE REFERENCES annotation_segments(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'claimed', 'in_progress', 'submitted', 'reviewing', 'approved', 'rework', 'cancelled')),
  assignee_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  claimed_at TIMESTAMPTZ,
  submitted_at TIMESTAMPTZ,
  reviewed_at TIMESTAMPTZ,
  review_comment TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(annotation_task_id, sequence)
);
CREATE INDEX IF NOT EXISTS annotation_jobs_claim_idx ON annotation_jobs(dataset_id, status, sequence);
ALTER TABLE annotation_jobs ADD COLUMN IF NOT EXISTS reviewer_id TEXT REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS annotation_jobs_review_idx ON annotation_jobs(dataset_id, status, sequence);
CREATE TABLE IF NOT EXISTS annotation_review_snapshots (
  id BIGSERIAL PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES annotation_jobs(id) ON DELETE CASCADE,
  image_id TEXT NOT NULL REFERENCES dataset_images(id) ON DELETE CASCADE,
  before_document JSONB,
  after_document JSONB NOT NULL,
  reviewer_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS annotation_review_snapshots_job_idx ON annotation_review_snapshots(job_id, created_at);
