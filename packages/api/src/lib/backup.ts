/**
 * Postgres backup utility: streams `pg_dump | gzip` straight to S3-compatible
 * object storage (AWS S3, DigitalOcean Spaces, GCS via interop, MinIO, …) using
 * a multipart streaming upload — so even large databases never buffer to disk.
 *
 * Destination is configured via env (kept separate from the attachments storage
 * so backups can live in their own bucket/account):
 *   BACKUP_S3_BUCKET            (required — enables backups)
 *   BACKUP_S3_REGION            (default us-east-1)
 *   BACKUP_S3_ENDPOINT          (optional — for Spaces/GCS/MinIO/B2)
 *   BACKUP_S3_ACCESS_KEY_ID
 *   BACKUP_S3_SECRET_ACCESS_KEY
 *   BACKUP_S3_PREFIX            (default "backups")
 *   BACKUP_PGDUMP_PATH          (default "pg_dump")
 */
import { spawn } from 'node:child_process';
import { createGzip } from 'node:zlib';
import { PassThrough } from 'node:stream';
import { S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { logger } from './logger.js';

export interface BackupConfig {
  bucket: string;
  region: string;
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  prefix: string;
}

export function resolveBackupConfig(): BackupConfig | null {
  const bucket = process.env['BACKUP_S3_BUCKET'];
  if (!bucket) return null;
  return {
    bucket,
    region: process.env['BACKUP_S3_REGION'] || 'us-east-1',
    ...(process.env['BACKUP_S3_ENDPOINT'] ? { endpoint: process.env['BACKUP_S3_ENDPOINT'] } : {}),
    accessKeyId: process.env['BACKUP_S3_ACCESS_KEY_ID'] || '',
    secretAccessKey: process.env['BACKUP_S3_SECRET_ACCESS_KEY'] || '',
    prefix: (process.env['BACKUP_S3_PREFIX'] || 'backups').replace(/\/+$/, ''),
  };
}

export function isBackupConfigured(): boolean {
  return Boolean(process.env['BACKUP_S3_BUCKET']);
}

/** Run a full database backup and upload it. Returns the object key + byte size. */
export async function runBackup(): Promise<{ key: string; bytes: number }> {
  const cfg = resolveBackupConfig();
  if (!cfg) throw new Error('Backups are not configured (set BACKUP_S3_BUCKET).');
  const dbUrl = process.env['DATABASE_URL'];
  if (!dbUrl) throw new Error('DATABASE_URL is not set.');

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const key = `${cfg.prefix}/enlight-${ts}.sql.gz`;

  // pg_dump (plain SQL) → gzip → byte counter → S3 multipart upload.
  const pgDump = process.env['BACKUP_PGDUMP_PATH'] || 'pg_dump';
  const dump = spawn(pgDump, ['--no-owner', '--no-privileges', '--format=plain', dbUrl], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  dump.stderr.on('data', (d) => { stderr += d.toString(); });

  const gzip = createGzip();
  let bytes = 0;
  const counter = new PassThrough();
  counter.on('data', (c: Buffer) => { bytes += c.length; });
  dump.stdout.pipe(gzip).pipe(counter);

  const client = new S3Client({
    region: cfg.region,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    ...(cfg.endpoint ? { endpoint: cfg.endpoint, forcePathStyle: true } : {}),
  });
  const upload = new Upload({
    client,
    params: { Bucket: cfg.bucket, Key: key, Body: counter, ContentType: 'application/gzip' },
  });

  const dumpDone = new Promise<void>((resolve, reject) => {
    dump.on('error', (err) => reject(new Error(`pg_dump failed to start: ${err.message}`)));
    dump.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`pg_dump exited ${code}: ${stderr.slice(0, 500)}`)),
    );
  });

  try {
    await Promise.all([upload.done(), dumpDone]);
  } finally {
    client.destroy();
  }
  logger.info('Database backup uploaded', { key, bytes, bucket: cfg.bucket });
  return { key, bytes };
}
