import type { Job } from 'bullmq';
import { runBackup } from '../../../api/src/lib/backup.js';
import { logger } from '../lib/logger.js';

/** Nightly Postgres backup: pg_dump | gzip → S3-compatible object storage. */
export async function handleBackupJob(_job: Job): Promise<void> {
  const result = await runBackup();
  logger.info('Nightly backup complete', result);
}
