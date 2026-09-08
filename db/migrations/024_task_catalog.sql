CREATE TABLE task_categories (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  description TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO task_categories(id, code, name, sort_order)
VALUES
  ('category-detection', 'detection-5e81', '目标检测', 0),
  ('category-semantic', 'semantic-segmentation-8d72', '语义分割', 1),
  ('category-keypoint', 'keypoint-3b46', '关键点检测', 2),
  ('category-instance', 'instance-segmentation-7c93', '实例分割', 3),
  ('category-lane', 'lane-detection-4f28', '车道线检测', 4);

CREATE TABLE task_types (
  id TEXT PRIMARY KEY,
  category_id TEXT NOT NULL REFERENCES task_categories(id),
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  description TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (category_id, name)
);

-- Existing datasets are removed by the explicit release cleanup, never by startup.
ALTER TABLE datasets ADD COLUMN task_type_id TEXT REFERENCES task_types(id);
ALTER TABLE datasets ADD COLUMN created_at TIMESTAMPTZ;
ALTER TABLE datasets ALTER COLUMN created_at SET DEFAULT NOW();
ALTER TABLE datasets ADD COLUMN approved_at TIMESTAMPTZ;
CREATE INDEX datasets_catalog_created_idx ON datasets(task_type_id, created_at DESC, id) WHERE status = '可训练';
CREATE INDEX datasets_created_idx ON datasets(created_at DESC, id);

CREATE FUNCTION record_dataset_approval() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = '可训练' AND (OLD.status IS DISTINCT FROM NEW.status OR NEW.approved_at IS NULL) THEN
    NEW.approved_at := NOW();
  ELSIF NEW.status <> '可训练' THEN
    NEW.approved_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER datasets_approval_timestamp BEFORE UPDATE ON datasets
FOR EACH ROW EXECUTE FUNCTION record_dataset_approval();

CREATE FUNCTION validate_dataset_task_binding() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.task_type_id IS DISTINCT FROM OLD.task_type_id THEN
    PERFORM t.id FROM task_types t JOIN task_categories c ON c.id = t.category_id
      WHERE t.id = NEW.task_type_id AND t.enabled AND c.enabled FOR SHARE OF t,c;
    IF NOT FOUND THEN
      RAISE EXCEPTION '请选择启用中的大类和业务任务' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER datasets_task_binding BEFORE INSERT OR UPDATE OF task_type_id ON datasets
FOR EACH ROW EXECUTE FUNCTION validate_dataset_task_binding();
