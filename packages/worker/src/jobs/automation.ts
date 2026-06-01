import type { Job } from 'bullmq';
import { logger } from '../lib/logger.js';
import { runEventAutomations, runTimeBasedAutomations } from '../../../api/src/lib/automationEngine.js';
import type { AutomationTriggerType } from '@enlight/shared';

interface AutomationJobData {
  event: AutomationTriggerType;
  requestId: string;
  commentId?: string;
}

/** Handles event-triggered automation jobs enqueued by the API. */
export async function handleAutomationJob(job: Job<AutomationJobData>): Promise<void> {
  const { event, requestId, commentId } = job.data;
  if (!event || !requestId) return;
  await runEventAutomations(event, requestId, commentId);
}

/** Handles the periodic time-based automation scan. */
export async function handleAutomationScanJob(_job: Job): Promise<void> {
  logger.debug('Automation time-based scan starting');
  await runTimeBasedAutomations();
}
