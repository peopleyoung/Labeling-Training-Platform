ALTER TABLE users ADD COLUMN IF NOT EXISTS roles JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE users ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT TRUE;
UPDATE users SET roles = jsonb_build_array(role) WHERE roles = '[]'::jsonb;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin', 'reviewer', 'engineer', 'annotator'));
CREATE TABLE IF NOT EXISTS user_roles (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('admin', 'reviewer', 'engineer', 'annotator')),
  PRIMARY KEY (user_id, role)
);
INSERT INTO user_roles(user_id, role)
SELECT users.id, jsonb_array_elements_text(users.roles)
FROM users
ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS system_settings (
  id TEXT PRIMARY KEY,
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO system_settings(id, settings) VALUES ('default', '{"uploadMaxBytes":536870912,"defaultImageSegmentSize":100,"defaultVideoSegmentSize":100,"autosaveIntervalSeconds":5,"retentionDays":30,"allowedVideoFormats":["mp4","mov","avi","mkv"]}'::jsonb) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS annotation_tasks (
  id TEXT PRIMARY KEY,
  dataset_id TEXT NOT NULL UNIQUE REFERENCES datasets(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'processing', 'annotating', 'reviewing', 'paused', 'completed', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS processing_runs (
  id TEXT PRIMARY KEY,
  dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  source_asset_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'partial_failed', 'failed', 'cancelled')),
  progress INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  extraction_strategy TEXT CHECK (extraction_strategy IN ('fps', 'interval_ms', 'keyframe')),
  fps NUMERIC,
  interval_ms INTEGER,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS processing_runs_dataset_created_idx ON processing_runs(dataset_id, created_at DESC);
ALTER TABLE processing_runs ADD COLUMN IF NOT EXISTS source_asset_id TEXT;

CREATE TABLE IF NOT EXISTS source_assets (
  id TEXT PRIMARY KEY,
  dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('image', 'archive', 'video')),
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL CHECK (size_bytes > 0),
  sha256 TEXT,
  object_key TEXT NOT NULL UNIQUE,
  relative_path TEXT,
  processing_error TEXT,
  upload_status TEXT NOT NULL DEFAULT 'created' CHECK (upload_status IN ('created', 'uploading', 'uploaded', 'upload_failed', 'cancelled')),
  processing_status TEXT NOT NULL DEFAULT 'pending' CHECK (processing_status IN ('pending', 'processing', 'processed', 'partial_failed', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS source_assets_dataset_created_idx ON source_assets(dataset_id, created_at, id);
ALTER TABLE source_assets ADD COLUMN IF NOT EXISTS processing_error TEXT;
ALTER TABLE processing_runs DROP CONSTRAINT IF EXISTS processing_runs_source_asset_id_fkey;
ALTER TABLE processing_runs ADD CONSTRAINT processing_runs_source_asset_id_fkey FOREIGN KEY (source_asset_id) REFERENCES source_assets(id) ON DELETE CASCADE;

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

CREATE TABLE IF NOT EXISTS upload_sessions (
  id TEXT PRIMARY KEY,
  dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL UNIQUE REFERENCES source_assets(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL CHECK (size_bytes > 0),
  part_size INTEGER NOT NULL CHECK (part_size > 0),
  total_parts INTEGER NOT NULL CHECK (total_parts > 0),
  status TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'uploading', 'uploaded', 'upload_failed', 'cancelled')),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS upload_parts (
  session_id TEXT NOT NULL REFERENCES upload_sessions(id) ON DELETE CASCADE,
  part_number INTEGER NOT NULL CHECK (part_number > 0),
  PRIMARY KEY (session_id, part_number)
);
