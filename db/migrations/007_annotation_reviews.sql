ALTER TABLE annotation_documents
  ADD COLUMN IF NOT EXISTS review_status TEXT NOT NULL DEFAULT 'draft'
    CHECK (review_status IN ('draft', 'submitted', 'approved', 'rejected')),
  ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS submitted_by TEXT REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reviewed_by TEXT REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS review_comment TEXT;

-- Existing non-empty annotations were already treated as ready for training.
-- Preserve that behavior during the first review-workflow migration.
UPDATE annotation_documents
SET review_status = 'approved',
    submitted_at = COALESCE(submitted_at, updated_at),
    submitted_by = COALESCE(submitted_by, updated_by),
    reviewed_at = COALESCE(reviewed_at, updated_at),
    reviewed_by = COALESCE(reviewed_by, updated_by)
WHERE review_status = 'draft'
  AND jsonb_array_length(annotations) > 0;

WITH review_counts AS (
  SELECT datasets.id AS dataset_id,
         COUNT(images.id) AS image_count,
         COUNT(documents.image_id) FILTER (WHERE documents.review_status = 'approved') AS approved_count,
         COUNT(documents.image_id) FILTER (WHERE documents.review_status = 'submitted') AS submitted_count
  FROM datasets
  LEFT JOIN dataset_images images ON images.dataset_id = datasets.id
  LEFT JOIN annotation_documents documents
    ON documents.dataset_id = datasets.id AND documents.image_id = images.id
  GROUP BY datasets.id
)
UPDATE datasets
SET status = CASE
  WHEN review_counts.image_count > 0 AND review_counts.approved_count = review_counts.image_count THEN '可训练'
  WHEN review_counts.submitted_count > 0 THEN '待审核'
  ELSE '标注中'
END
FROM review_counts
WHERE datasets.id = review_counts.dataset_id;

CREATE INDEX IF NOT EXISTS idx_annotation_documents_dataset_review_status
  ON annotation_documents(dataset_id, review_status);
