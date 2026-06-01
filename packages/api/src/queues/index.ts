import { Queue } from 'bullmq';

const connection = { url: process.env['REDIS_URL'] ?? 'redis://localhost:6379' };

export const agentQueue = new Queue('agent', { connection });
export const kbSyncQueue = new Queue('kb-sync', { connection });
export const slaMonitorQueue = new Queue('sla-monitor', { connection });
export const scimSyncQueue = new Queue('scim-sync', { connection });
export const automationQueue = new Queue('automation', { connection });
export const offboardingQueue = new Queue('offboarding', { connection });
export const webhookQueue    = new Queue('webhook', { connection });

/** Fire-and-forget enqueue of an automation event; never breaks the caller.
 *  For `comment_added`, pass the commentId so comment conditions can evaluate. */
export async function enqueueAutomationEvent(
  event: 'request_created' | 'request_updated' | 'comment_added',
  requestId: string,
  commentId?: string,
): Promise<void> {
  try {
    await automationQueue.add(event, { event, requestId, commentId });
  } catch (err) {
    // Redis unavailable etc. — log via console to avoid a hard dep here.
    console.error('Failed to enqueue automation event', event, requestId, err);
  }
}
