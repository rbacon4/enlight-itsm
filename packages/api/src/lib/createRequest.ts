/**
 * Central helper for creating a new request with an atomically-assigned
 * per-project ticket number.  Use this instead of a bare db.insert(requests)
 * so every code path (REST API, Slack intake, tests) gets consistent numbering.
 */
import { db } from '../db/client.js';
import { requests, projects } from '../db/schema.js';
import { eq, sql } from 'drizzle-orm';
import { enqueueAutomationEvent } from '../queues/index.js';
import { notifyTicketCreated } from './notifier.js';
import type { RequestPriority, RequestStatus } from '@enlight/shared';

export interface CreateRequestInput {
  projectId: string;
  requesterId: string;
  title: string;
  description?: string;
  priority?: RequestPriority;
  status?: RequestStatus;
  category?: string | undefined;
  subcategory?: string | undefined;
  slackUserId?: string | undefined;
  slackThreadTs?: string | undefined;
  customFields?: Record<string, unknown> | undefined;
}

export async function createRequest(input: CreateRequestInput) {
  // Atomically claim the next ticket number for this project
  const [updated] = await db
    .update(projects)
    .set({ lastTicketNumber: sql`${projects.lastTicketNumber} + 1` })
    .where(eq(projects.id, input.projectId))
    .returning({ ticketNumber: projects.lastTicketNumber, key: projects.key });

  if (!updated) throw new Error(`Project ${input.projectId} not found`);

  const [newRequest] = await db
    .insert(requests)
    .values({
      projectId: input.projectId,
      requesterId: input.requesterId,
      ticketNumber: updated.ticketNumber,
      title: input.title,
      description: input.description ?? '',
      priority: input.priority ?? 'medium',
      status: input.status ?? 'open',
      category: input.category,
      subcategory: input.subcategory,
      slackUserId: input.slackUserId,
      slackThreadTs: input.slackThreadTs,
      customFields: input.customFields ?? {},
    })
    .returning();

  if (!newRequest) throw new Error('Failed to create request');

  // Fire request_created automations and email confirmation.
  void enqueueAutomationEvent('request_created', newRequest.id);
  notifyTicketCreated(newRequest.id);

  return { request: newRequest, projectKey: updated.key };
}
