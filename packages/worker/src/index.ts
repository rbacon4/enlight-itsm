import 'dotenv/config';
import { Worker, Queue } from 'bullmq';
import { logger } from './lib/logger.js';
import { handleAgentJob } from './jobs/agent.js';
import { handleKbSyncJob } from './jobs/kbSync.js';
import { handleSlaMonitorJob } from './jobs/slaMonitor.js';
import { handleAutomationJob, handleAutomationScanJob } from './jobs/automation.js';
import { handleOffboardingJob } from './jobs/offboarding.js';
import { handleBackupJob } from './jobs/backup.js';
import { handleWebhookJob } from './jobs/webhook.js';
import { handleRipplingSyncJob } from './jobs/ripplingSync.js';
import { handleJumpCloudSyncJob } from './jobs/jumpcloudSync.js';
import { handleOktaSyncJob } from './jobs/oktaSync.js';
import { isBackupConfigured } from '../../api/src/lib/backup.js';
import { db } from '../../api/src/db/client.js';
import { organizations } from '../../api/src/db/schema.js';
import type { OrganizationSettings } from '@enlight/shared';

const connection = { url: process.env['REDIS_URL'] ?? 'redis://localhost:6379' };

const agentWorker = new Worker('agent', handleAgentJob, { connection, concurrency: 5 });
const kbSyncWorker = new Worker('kb-sync', handleKbSyncJob, { connection, concurrency: 2 });
const slaMonitorWorker = new Worker('sla-monitor', handleSlaMonitorJob, { connection, concurrency: 1 });
const automationWorker = new Worker('automation', handleAutomationJob, { connection, concurrency: 3 });
const automationScanWorker = new Worker('automation-scan', handleAutomationScanJob, { connection, concurrency: 1 });
const offboardingWorker = new Worker('offboarding', handleOffboardingJob, { connection, concurrency: 2 });
const backupWorker  = new Worker('backup',  handleBackupJob,  { connection, concurrency: 1 });
const webhookWorker = new Worker('webhook', handleWebhookJob, { connection, concurrency: 10 });
const ripplingSyncWorker = new Worker('rippling-sync', (job) => handleRipplingSyncJob(job.data as { orgId: string }), { connection, concurrency: 2 });
const jumpcloudSyncWorker = new Worker('jumpcloud-sync', (job) => handleJumpCloudSyncJob(job.data as { orgId: string }), { connection, concurrency: 2 });
const oktaSyncWorker = new Worker('okta-sync', (job) => handleOktaSyncJob(job.data as { orgId: string }), { connection, concurrency: 2 });

const workers = [agentWorker, kbSyncWorker, slaMonitorWorker, automationWorker, automationScanWorker, offboardingWorker, backupWorker, webhookWorker, ripplingSyncWorker, jumpcloudSyncWorker, oktaSyncWorker];

for (const worker of workers) {
  worker.on('completed', (job) => {
    logger.debug('Job completed', { queue: worker.name, jobId: job.id });
  });
  worker.on('failed', (job, err) => {
    logger.error('Job failed', { queue: worker.name, jobId: job?.id, err });
  });
}

// Schedule the time-based automation scan to run every minute.
const automationScanQueue = new Queue('automation-scan', { connection });
await automationScanQueue.add('scan', {}, {
  repeat: { every: 60_000 },
  removeOnComplete: true,
  removeOnFail: true,
});

// Schedule the SLA monitor to run every 5 minutes (configurable via SLA_MONITOR_INTERVAL_MS).
const slaMonitorQueue = new Queue('sla-monitor', { connection });
await slaMonitorQueue.add('scan', {}, {
  repeat: { every: parseInt(process.env['SLA_MONITOR_INTERVAL_MS'] ?? '300000', 10) },
  removeOnComplete: 5,
  removeOnFail: 10,
});

// Schedule the nightly database backup (only when a backup destination is set).
const backupQueue = new Queue('backup', { connection });
if (isBackupConfigured()) {
  await backupQueue.add('nightly', {}, {
    repeat: { pattern: process.env['BACKUP_CRON'] || '0 3 * * *' },
    removeOnComplete: 10,
    removeOnFail: 20,
  });
  logger.info('Nightly backup scheduled', { cron: process.env['BACKUP_CRON'] || '0 3 * * *' });
}

// Schedule directory sync jobs (every 4h by default) for each org that has them enabled.
const ripplingCron = process.env['RIPPLING_SYNC_CRON'] ?? '0 */4 * * *';
const jumpcloudCron = process.env['JUMPCLOUD_SYNC_CRON'] ?? '0 */4 * * *';
const oktaCron = process.env['OKTA_SYNC_CRON'] ?? '0 */4 * * *';

try {
  const allOrgs = await db.select({ id: organizations.id, settings: organizations.settings }).from(organizations);
  const ripplingQueue = new Queue('rippling-sync', { connection });
  const jumpcloudQueue = new Queue('jumpcloud-sync', { connection });
  const oktaQueue = new Queue('okta-sync', { connection });

  for (const org of allOrgs) {
    const s = (org.settings ?? {}) as OrganizationSettings;
    if (s.rippling?.syncEnabled) {
      await ripplingQueue.add('sync', { orgId: org.id }, {
        repeat: { pattern: ripplingCron },
        removeOnComplete: 5,
        removeOnFail: 10,
      });
    }
    if (s.jumpcloud?.syncEnabled) {
      await jumpcloudQueue.add('sync', { orgId: org.id }, {
        repeat: { pattern: jumpcloudCron },
        removeOnComplete: 5,
        removeOnFail: 10,
      });
    }
    if (s.okta?.syncEnabled) {
      await oktaQueue.add('sync', { orgId: org.id }, {
        repeat: { pattern: oktaCron },
        removeOnComplete: 5,
        removeOnFail: 10,
      });
    }
  }
} catch (err) {
  logger.warn('Failed to schedule directory sync jobs', { err });
}

logger.info('Enlight worker running', {
  queues: ['agent', 'kb-sync', 'sla-monitor', 'automation', 'automation-scan', 'offboarding', 'backup', 'webhook', 'rippling-sync', 'jumpcloud-sync', 'okta-sync'],
});

process.on('SIGTERM', async () => {
  logger.info('Shutting down workers...');
  await Promise.all(workers.map((w) => w.close()));
  process.exit(0);
});
