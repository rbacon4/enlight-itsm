/**
 * Lightweight production migration runner.
 *
 * Applies the SQL migrations in packages/api/drizzle/ using drizzle-orm's own
 * migrator (no drizzle-kit / esbuild needed at runtime). Invoked by the Docker
 * entrypoint before the app starts, so self-hosters never run migrations by hand:
 *
 *   node dist/db/migrate.js
 */
import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { db, pool } from './client.js';
import { logger } from '../lib/logger.js';

// drizzle/ sits next to dist/ under packages/api (../../drizzle from dist/db or src/db).
const migrationsFolder =
  process.env['DRIZZLE_MIGRATIONS_DIR'] ||
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../drizzle');

async function main(): Promise<void> {
  if (!process.env['DATABASE_URL']) {
    logger.error('DATABASE_URL is not set — cannot run migrations.');
    process.exit(1);
  }
  logger.info('Running database migrations', { migrationsFolder });
  await migrate(db, { migrationsFolder });
  logger.info('Database migrations complete.');
  await pool.end();
}

main().catch((err) => {
  logger.error('Database migration failed', { err });
  process.exit(1);
});
