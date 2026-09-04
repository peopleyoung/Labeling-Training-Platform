UPDATE users SET role = 'reviewer' WHERE role = 'engineer';
UPDATE users
SET roles = (
  SELECT jsonb_agg(DISTINCT CASE WHEN value = 'engineer' THEN 'reviewer' ELSE value END)
  FROM jsonb_array_elements_text(COALESCE(roles, jsonb_build_array(role))) AS role_values(value)
);
DELETE FROM user_roles engineer_role
WHERE engineer_role.role = 'engineer'
  AND EXISTS (SELECT 1 FROM user_roles reviewer_role WHERE reviewer_role.user_id = engineer_role.user_id AND reviewer_role.role = 'reviewer');
UPDATE user_roles SET role = 'reviewer' WHERE role = 'engineer';
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin', 'reviewer', 'annotator'));
ALTER TABLE user_roles DROP CONSTRAINT IF EXISTS user_roles_role_check;
ALTER TABLE user_roles ADD CONSTRAINT user_roles_role_check CHECK (role IN ('admin', 'reviewer', 'annotator'));
