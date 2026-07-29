ALTER TABLE dataset_images ADD COLUMN IF NOT EXISTS filename TEXT NOT NULL DEFAULT '';
ALTER TABLE dataset_images ADD COLUMN IF NOT EXISTS mime_type TEXT NOT NULL DEFAULT 'application/octet-stream';
ALTER TABLE dataset_images ADD COLUMN IF NOT EXISTS size_bytes BIGINT NOT NULL DEFAULT 0 CHECK (size_bytes >= 0);

ALTER TABLE export_tasks ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'all' CHECK (scope IN ('all', 'train', 'validation', 'test'));
ALTER TABLE export_tasks ADD COLUMN IF NOT EXISTS version_name TEXT NOT NULL DEFAULT '';
ALTER TABLE export_tasks ADD COLUMN IF NOT EXISTS include_images BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE conversion_jobs ADD COLUMN IF NOT EXISTS artifact_id TEXT REFERENCES artifacts(id);
ALTER TABLE model_versions ADD COLUMN IF NOT EXISTS artifact_id TEXT REFERENCES artifacts(id);

CREATE INDEX IF NOT EXISTS dataset_images_dataset_created_idx ON dataset_images (dataset_id, created_at);
