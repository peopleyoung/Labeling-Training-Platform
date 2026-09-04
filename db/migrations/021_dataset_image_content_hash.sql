ALTER TABLE dataset_images ADD COLUMN IF NOT EXISTS content_sha256 TEXT;
CREATE INDEX IF NOT EXISTS dataset_images_duplicate_identity_idx ON dataset_images(dataset_id, content_sha256, source_relative_path);
