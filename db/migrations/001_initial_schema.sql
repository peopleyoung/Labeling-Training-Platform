CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'engineer', 'annotator')),
  must_change_password BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS datasets (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  version TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('目标检测', '语义分割', '关键点')),
  images INTEGER NOT NULL CHECK (images >= 0),
  annotated INTEGER NOT NULL CHECK (annotated >= 0 AND annotated <= images),
  classes JSONB NOT NULL DEFAULT '[]'::jsonb,
  size TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('标注中', '可训练', '待审核')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS dataset_images (
  id TEXT PRIMARY KEY,
  dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  object_key TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  split TEXT NOT NULL DEFAULT 'train' CHECK (split IN ('train', 'validation', 'test')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS annotation_documents (
  dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  image_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  annotations JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_by TEXT NOT NULL REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (dataset_id, image_id)
);

CREATE TABLE IF NOT EXISTS training_jobs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('detection', 'segmentation', 'keypoint', 'sdxl')),
  model TEXT NOT NULL,
  dataset TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  progress INTEGER NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 100),
  epoch TEXT NOT NULL,
  metric_name TEXT NOT NULL,
  metric_value TEXT NOT NULL,
  gpu TEXT NOT NULL,
  eta TEXT NOT NULL,
  created_by TEXT REFERENCES users(id),
  error_message TEXT,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS model_versions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  task TEXT NOT NULL CHECK (task IN ('detection', 'segmentation', 'keypoint', 'sdxl')),
  source_job TEXT NOT NULL,
  metric_name TEXT NOT NULL,
  metric_value TEXT NOT NULL,
  framework TEXT NOT NULL,
  size TEXT NOT NULL,
  formats JSONB NOT NULL DEFAULT '[]'::jsonb,
  stage TEXT NOT NULL CHECK (stage IN ('生产候选', '评估中', '已归档')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, name, version)
);

CREATE TABLE IF NOT EXISTS conversion_jobs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  model_name TEXT NOT NULL,
  model_version TEXT NOT NULL,
  format TEXT NOT NULL CHECK (format IN ('ONNX', 'TensorRT', 'TorchScript', 'OpenVINO')),
  precision TEXT NOT NULL,
  target TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  progress INTEGER NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 100),
  size TEXT NOT NULL,
  created_by TEXT REFERENCES users(id),
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS export_tasks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  format TEXT NOT NULL CHECK (format IN ('COCO', 'VOC', 'SEGMENTATION')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  progress INTEGER NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 100),
  artifact_id TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  object_key TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0),
  sha256 TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  created_by TEXT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGSERIAL PRIMARY KEY,
  actor_id TEXT REFERENCES users(id),
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS training_jobs_workspace_created_idx ON training_jobs (workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS conversion_jobs_workspace_created_idx ON conversion_jobs (workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS annotation_documents_dataset_idx ON annotation_documents (dataset_id);
CREATE INDEX IF NOT EXISTS audit_logs_actor_created_idx ON audit_logs (actor_id, created_at DESC);
