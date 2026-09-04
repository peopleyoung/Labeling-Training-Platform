ALTER TABLE annotation_tasks DROP CONSTRAINT IF EXISTS annotation_tasks_status_check;
ALTER TABLE annotation_tasks ADD CONSTRAINT annotation_tasks_status_check CHECK (status IN ('draft', 'processing', 'ready', 'annotating', 'reviewing', 'paused', 'completed', 'cancelled'));
