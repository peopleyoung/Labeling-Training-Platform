UPDATE users
SET roles = jsonb_build_array(role);

DELETE FROM user_roles;

INSERT INTO user_roles(user_id, role)
SELECT id, role FROM users;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_roles_single_role_check;
ALTER TABLE users ADD CONSTRAINT users_roles_single_role_check CHECK (jsonb_array_length(roles) = 1);
