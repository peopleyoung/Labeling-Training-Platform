import bcrypt from 'bcryptjs';
import { Pool } from 'pg';
import { loadConfig } from './config';
import { workspaceId } from './workspace';

interface BootstrapAdmin {
  username: string;
  password: string;
  displayName: string;
}

export async function seedDatabase(databaseUrl: string, bootstrapAdmin: BootstrapAdmin) {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await pool.query('INSERT INTO workspaces(id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [workspaceId, '工业质检工作空间']);
    const passwordHash = await bcrypt.hash(bootstrapAdmin.password, 12);
    await pool.query(
      'INSERT INTO users(id, workspace_id, username, display_name, password_hash, role, must_change_password) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO UPDATE SET username = EXCLUDED.username, display_name = EXCLUDED.display_name, role = EXCLUDED.role',
      ['user-admin', workspaceId, bootstrapAdmin.username, bootstrapAdmin.displayName, passwordHash, 'admin', true],
    );
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  if (!config.databaseUrl) throw new Error('DATABASE_URL is required for seed data');
  if (!config.bootstrapAdmin) throw new Error('BOOTSTRAP_ADMIN_PASSWORD is required for initial admin creation');
  seedDatabase(config.databaseUrl, config.bootstrapAdmin).then(() => console.info('Workspace and bootstrap administrator are ready'));
}
