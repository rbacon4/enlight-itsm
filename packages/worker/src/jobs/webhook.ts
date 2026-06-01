/**
 * Webhook delivery worker job.
 *
 * Performs a single HTTP POST to the registered endpoint, records the outcome
 * in `webhook_deliveries`, and throws on non-2xx so BullMQ retries with
 * exponential backoff (configured at enqueue time in lib/webhooks.ts).
 */

import type { Job } from 'bullmq';
import crypto from 'crypto';
import { db } from '../../../api/src/db/client.js';
import { webhookDeliveries } from '../../../api/src/db/schema.js';
import type { WebhookJobData } from '../../../api/src/lib/webhooks.js';
import { logger } from '../lib/logger.js';

export async function handleWebhookJob(job: Job<WebhookJobData>): Promise<void> {
  const { webhookId, url, secret, event, payload } = job.data;
  const attemptNumber = (job.attemptsMade ?? 0) + 1;
  const body = JSON.stringify(payload);
  const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');

  const start = Date.now();
  let statusCode: number | null = null;
  let responseBody: string | null = null;
  let success = false;

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Enlight-Signature': `sha256=${sig}`,
        'X-Enlight-Event': event,
        'User-Agent': 'Enlight-Webhooks/1.0',
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });

    statusCode = resp.status;
    responseBody = (await resp.text()).slice(0, 1024);
    success = resp.ok;

    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} — ${responseBody.slice(0, 200)}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (statusCode === null) responseBody = msg.slice(0, 1024);

    logger.warn('Webhook delivery failed', { webhookId, url, event, attempt: attemptNumber, err: msg });

    // Record failed attempt and re-throw so BullMQ schedules a retry.
    await recordDelivery({ webhookId, event, statusCode, responseBody, durationMs: Date.now() - start, success: false, attemptNumber });
    throw err;
  }

  await recordDelivery({ webhookId, event, statusCode, responseBody, durationMs: Date.now() - start, success: true, attemptNumber });
  logger.debug('Webhook delivered', { webhookId, url, event, statusCode });
}

async function recordDelivery(d: {
  webhookId: string; event: string; statusCode: number | null;
  responseBody: string | null; durationMs: number; success: boolean; attemptNumber: number;
}): Promise<void> {
  try {
    await db.insert(webhookDeliveries).values({
      webhookId: d.webhookId,
      event: d.event,
      statusCode: d.statusCode,
      responseBody: d.responseBody,
      durationMs: d.durationMs,
      success: d.success,
      attemptNumber: d.attemptNumber,
    });
  } catch (err) {
    logger.warn('Failed to record webhook delivery', { err });
  }
}
