import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Pool } from 'pg';
import { loadConfig } from './config';

export async function migrate(databaseUrl: string) {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
    const directory = join(process.cwd(), 'db', 'migrations');
    const files = (await readdir(directory)).filter((file) => file.endsWith('.sql')).sort();
    for (const file of files) {
      const applied = await pool.query('SELECT 1 FROM schema_migrations WHERE id = $1', [file]);
      if (applied.rowCount) continue;
      const sql = await readFile(join(directory, file), 'utf8');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(id) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  if (!config.databaseUrl) throw new Error('DATABASE_URL is required for migrations');
  migrate(config.databaseUrl).then(() => console.info('Database migrations are up to date'));
}
