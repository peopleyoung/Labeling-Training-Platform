DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM datasets WHERE task_type_id IS NULL OR created_at IS NULL) THEN
    RAISE EXCEPTION 'Run the approved one-time dataset catalog reset before applying this migration';
  END IF;
END;
$$;
ALTER TABLE datasets ALTER COLUMN task_type_id SET NOT NULL;
ALTER TABLE datasets ALTER COLUMN created_at SET NOT NULL;
ALTER TABLE datasets DROP COLUMN type;
