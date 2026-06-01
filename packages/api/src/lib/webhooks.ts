/**
 * Outbound webhook dispatch.
 *
 * `deliverWebhooks` enqueues one job per matching endpoint into the 'webhook'
 * BullMQ queue.  The worker (`packages/worker/src/jobs/webhook.ts`) does the
 * actual HTTP POST with exponential-backoff retries and records each attempt
 * in `webhook_deliveries`.
 */

import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { webhooks } from '../db/schema.js';
import { webhookQueue } from '../queues/index.js';
import { logger } from './logger.js';

export type WebhookEvent =
  | 'request.created'
  | 'request.updated'
  | 'request.resolved'
  | 'comment.added';

export interface WebhookJobData {
  webhookId: string;
  url: string;
  secret: string;
  event: WebhookEvent;
  payload: Record<string, unknown>;
}

/** Fire-and-forget: look up matching webhooks and enqueue a delivery job for each. */
export function deliverWebhooks(
  orgId: string,
  event: WebhookEvent,
  data: Record<string, unknown>,
): void {
  enqueue(orgId, event, data).catch((err) =>
    logger.warn('Webhook enqueue error', { orgId, event, err }),
  );
}

async function enqueue(
  orgId: string,
  event: WebhookEvent,
  data: Record<string, unknown>,
): Promise<void> {
  const rows = await db
    .select({ id: webhooks.id, url: webhooks.url, secret: webhooks.secret })
    .from(webhooks)
    .where(
      and(
        eq(webhooks.orgId, orgId),
        eq(webhooks.active, true),
        sql`(${webhooks.events} = '{}' OR ${webhooks.events} @> ARRAY[${event}]::text[])`,
      ),
    );

  if (rows.length === 0) return;

  const payload = { event, timestamp: new Date().toISOString(), data };

  await Promise.allSettled(
    rows.map((hook) =>
      webhookQueue.add(
        'deliver',
        { webhookId: hook.id, url: hook.url, secret: hook.secret, event, payload } satisfies WebhookJobData,
        {
          attempts: 4,
          backoff: { type: 'exponential', delay: 30_000 }, // 30s, 1m, 2m, 4m
          removeOnComplete: 100,
          removeOnFail: 200,
        },
      ),
    ),
  );
}
