import type Anthropic from '@anthropic-ai/sdk';
import { db } from '../db/client.js';
import {
  requests,
  comments,
  knowledgeChunks,
  knowledgeSources,
  users,
  projects,
} from '../db/schema.js';
import { eq, and, inArray, sql } from 'drizzle-orm';
import type { RequestPriority, RequestStatus, OrganizationSettings } from '@enlight/shared';
import { embedText, type EmbeddingKeyOverrides } from '../lib/embeddings.js';
import { logger } from '../lib/logger.js';
import { makeSlackClient } from '../slack/client.js';
import { createOffboardingEvent, validateOffboardingInput } from '../lib/offboarding.js';
import { offboardingQueue } from '../queues/index.js';
import { computeOnCall } from '../lib/oncall.js';
import { oncallSchedules } from '../db/schema.js';

export const agentToolDefinitions: Anthropic.Tool[] = [
  {
    name: 'get_request',
    description: 'Retrieve a single request by ID with its full details and comment history.',
    input_schema: {
      type: 'object',
      properties: { requestId: { type: 'string', description: 'UUID of the request' } },
      required: ['requestId'],
    },
  },
  {
    name: 'update_request',
    description: 'Update fields on an existing request (status, priority, assignee, etc.).',
    input_schema: {
      type: 'object',
      properties: {
        requestId: { type: 'string' },
        fields: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['open', 'in_progress', 'pending_user', 'resolved', 'closed'] },
            priority: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
            title: { type: 'string' },
            description: { type: 'string' },
            category: { type: 'string' },
            assigneeId: { type: 'string' },
          },
        },
      },
      required: ['requestId', 'fields'],
    },
  },
  {
    name: 'add_comment',
    description: 'Add a comment (reply or internal note) to a request.',
    input_schema: {
      type: 'object',
      properties: {
        requestId: { type: 'string' },
        body: { type: 'string', description: 'Comment text in markdown' },
        isInternal: { type: 'boolean', description: 'If true, only agents can see this note', default: false },
      },
      required: ['requestId', 'body'],
    },
  },
  {
    name: 'list_agents',
    description: 'List all agents and admins in the project who can be assigned requests. Call this before assign_request to get valid agent IDs.',
    input_schema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project ID to list agents for' },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'assign_request',
    description: 'Assign a request to an agent. Use list_agents first to get a valid agentId UUID.',
    input_schema: {
      type: 'object',
      properties: {
        requestId: { type: 'string' },
        agentId: { type: 'string', description: 'UUID of the agent user to assign (get from list_agents)' },
      },
      required: ['requestId', 'agentId'],
    },
  },
  {
    name: 'escalate_request',
    description: 'Escalate a request, marking it as critical and adding an escalation note.',
    input_schema: {
      type: 'object',
      properties: {
        requestId: { type: 'string' },
        reason: { type: 'string', description: 'Reason for escalation' },
      },
      required: ['requestId', 'reason'],
    },
  },
  {
    name: 'offboard_user',
    description:
      "Offboard a departing employee in Google Workspace: suspend their account, move it to the Departed (or Archive) OU, and optionally transfer their Drive files to a delegate. This is a sensitive operation — confirm the target (and delegate) email with the requester before calling it unless you are operating in autonomous mode. The actions are reversible by a Workspace super admin.",
    input_schema: {
      type: 'object',
      properties: {
        targetEmail: { type: 'string', description: 'Email of the departing employee' },
        delegateEmail: { type: 'string', description: 'Optional email to transfer the departing user\'s Drive files to' },
        archive: { type: 'boolean', description: 'Move to the Archive OU instead of the Departed OU', default: false },
        projectId: { type: 'string', description: 'The current project ID (used to resolve the organization)' },
      },
      required: ['targetEmail', 'projectId'],
    },
  },
  {
    name: 'search_knowledge_base',
    description: 'Search the project knowledge base for relevant articles using semantic search.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        projectId: { type: 'string' },
        topK: { type: 'number', default: 5, description: 'Number of results to return' },
      },
      required: ['query', 'projectId'],
    },
  },
];

interface ToolInput {
  requestId?: string;
  agentId?: string;
  reason?: string;
  fields?: Record<string, unknown>;
  body?: string;
  isInternal?: boolean;
  query?: string;
  projectId?: string;
  topK?: number;
  targetEmail?: string;
  delegateEmail?: string;
  archive?: boolean;
  [key: string]: unknown;
}

export async function executeTool(
  toolName: string,
  input: ToolInput,
  agentUserId: string,
  orgSettings?: OrganizationSettings,
): Promise<unknown> {
  const embeddingOverrides: EmbeddingKeyOverrides = {
    anthropicApiKey: orgSettings?.anthropicApiKey,
    voyageApiKey:    orgSettings?.voyageApiKey,
    openAiApiKey:    orgSettings?.openAiApiKey,
    embeddingProvider: orgSettings?.embeddingProvider,
  };
  switch (toolName) {
    case 'get_request': {
      const [req] = await db
        .select()
        .from(requests)
        .where(eq(requests.id, input.requestId!))
        .limit(1);
      if (!req) return { error: 'Request not found' };
      const requestComments = await db
        .select()
        .from(comments)
        .where(eq(comments.requestId, req.id))
        .orderBy(comments.createdAt);
      return { ...req, comments: requestComments };
    }

    case 'update_request': {
      const [updated] = await db
        .update(requests)
        .set({ ...(input.fields as object), updatedAt: new Date() })
        .where(eq(requests.id, input.requestId!))
        .returning();
      return updated ?? { error: 'Request not found' };
    }

    case 'add_comment': {
      const [comment] = await db
        .insert(comments)
        .values({
          requestId: input.requestId!,
          authorId: agentUserId,
          body: input.body!,
          isInternal: input.isInternal ?? false,
          aiGenerated: true,
        })
        .returning();

      // If this is a public (non-internal) comment, deliver it to the requester via Slack DM
      if (comment && !(input.isInternal ?? false)) {
        try {
          const [req] = await db
            .select({ slackUserId: requests.slackUserId, slackThreadTs: requests.slackThreadTs })
            .from(requests)
            .where(eq(requests.id, input.requestId!))
            .limit(1);

          if (req?.slackUserId) {
            const slack = makeSlackClient(orgSettings);
            if (slack) {
              const text = input.body!;
              if (req.slackThreadTs) {
                await slack.chat.postMessage({
                  channel: req.slackUserId,
                  thread_ts: req.slackThreadTs,
                  text,
                });
              } else {
                await slack.chat.postMessage({
                  channel: req.slackUserId,
                  text,
                });
              }
            }
          }
        } catch (slackErr) {
          // Non-fatal — log but don't fail the tool call
          logger.warn('Failed to send AI comment via Slack', { slackErr });
        }
      }

      return comment;
    }

    case 'list_agents': {
      // Get org ID from the project
      const [proj] = await db
        .select({ orgId: projects.orgId })
        .from(projects)
        .where(eq(projects.id, input.projectId!))
        .limit(1);
      if (!proj) return { error: 'Project not found' };

      const agents = await db
        .select({ id: users.id, name: users.name, email: users.email, role: users.globalRole })
        .from(users)
        .where(
          and(
            eq(users.orgId, proj.orgId),
            inArray(users.globalRole, ['super_admin', 'admin', 'agent']),
          ),
        );
      return agents;
    }

    case 'assign_request': {
      try {
        const [updated] = await db
          .update(requests)
          .set({ assigneeId: input.agentId, status: 'in_progress', updatedAt: new Date() })
          .where(eq(requests.id, input.requestId!))
          .returning();
        return updated ?? { error: 'Request not found' };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { error: `assign_request failed: ${msg}. Use list_agents to get a valid agent UUID.` };
      }
    }

    case 'escalate_request': {
      const [updated] = await db
        .update(requests)
        .set({ priority: 'critical' as RequestPriority, updatedAt: new Date() })
        .where(eq(requests.id, input.requestId!))
        .returning();
      if (!updated) return { error: 'Request not found' };

      // Look up the on-call person for this project and notify them.
      let onCallNote = '';
      try {
        const schedules = await db
          .select()
          .from(oncallSchedules)
          .where(eq(oncallSchedules.projectId, updated.projectId));

        for (const sched of schedules) {
          const schedule = sched as typeof sched & {
            timezone: string; rotationDays: number; handoffTime: string;
            startDate: string; participants: string[];
          };
          const { currentOnCallUserId } = computeOnCall(schedule);
          if (!currentOnCallUserId) continue;

          const [onCallUser] = await db
            .select({ name: users.name, slackUserId: users.slackUserId })
            .from(users)
            .where(eq(users.id, currentOnCallUserId))
            .limit(1);

          if (!onCallUser) continue;
          onCallNote = ` On-call: ${onCallUser.name}.`;

          // Send Slack DM to on-call person.
          const slack = orgSettings ? makeSlackClient(orgSettings) : null;
          if (slack && onCallUser.slackUserId) {
            const [proj] = await db
              .select({ key: projects.key })
              .from(projects)
              .where(eq(projects.id, updated.projectId))
              .limit(1);
            await slack.chat.postMessage({
              channel: onCallUser.slackUserId,
              text: `🚨 *On-call escalation* — ${proj?.key ?? ''}-${updated.ticketNumber}: ${updated.title}\n*Reason:* ${input.reason}`,
            }).catch(() => { /* non-fatal */ });
          }
          break; // notify first matching schedule only
        }
      } catch { /* escalation still succeeds even if on-call lookup fails */ }

      await db.insert(comments).values({
        requestId: input.requestId!,
        authorId: agentUserId,
        body: `**Escalated:** ${input.reason}${onCallNote}`,
        isInternal: true,
        aiGenerated: true,
      });
      return updated;
    }

    case 'search_knowledge_base': {
      try {
        const queryEmbedding = await embedText(input.query!, embeddingOverrides);
        const vecLiteral = `[${queryEmbedding.join(',')}]`;
        const chunks = await db
          .select({
            id: knowledgeChunks.id,
            title: knowledgeChunks.title,
            body: knowledgeChunks.body,
            sourceUrl: knowledgeChunks.sourceUrl,
            metadata: knowledgeChunks.metadata,
          })
          .from(knowledgeChunks)
          .innerJoin(knowledgeSources, eq(knowledgeSources.id, knowledgeChunks.sourceId))
          .where(
            and(
              eq(knowledgeSources.projectId, input.projectId!),
              sql`${knowledgeChunks.embedding} IS NOT NULL`,
            ),
          )
          .orderBy(sql`${knowledgeChunks.embedding} <=> ${vecLiteral}::vector`)
          .limit(input.topK ?? 5);
        return chunks;
      } catch (err) {
        // KB search is non-fatal — let the agent continue without it
        logger.warn('KB search unavailable, continuing without it', { err });
        return { results: [], note: 'Knowledge base search is not available (embedding key not configured). Proceeding without KB context.' };
      }
    }

    case 'offboard_user': {
      if (!orgSettings?.offboarding?.enabled) {
        return { error: 'Offboarding is not enabled for this organization. An admin can configure it in Settings → Offboarding.' };
      }
      const [proj] = await db
        .select({ orgId: projects.orgId })
        .from(projects)
        .where(eq(projects.id, input.projectId!))
        .limit(1);
      if (!proj) return { error: 'Project not found' };

      const validationError = validateOffboardingInput(input.targetEmail ?? '', input.delegateEmail ?? null);
      if (validationError) return { error: validationError };

      try {
        const event = await createOffboardingEvent({
          orgId: proj.orgId,
          targetEmail: input.targetEmail!,
          delegateEmail: input.delegateEmail ?? null,
          archive: input.archive ?? false,
          triggeredById: agentUserId,
          triggeredVia: 'agent',
        });
        await offboardingQueue.add(
          'run',
          { eventId: event.id },
          { attempts: 2, backoff: { type: 'exponential', delay: 3000 } },
        );
        return {
          eventId: event.id,
          status: 'processing',
          message: `Offboarding started for ${input.targetEmail}. The account will be suspended and moved to the ${input.archive ? 'Archive' : 'Departed'} OU${input.delegateEmail ? `, with Drive files transferred to ${input.delegateEmail}` : ''}. A tracking ticket and audit summary will follow.`,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { error: `offboard_user failed: ${msg}` };
      }
    }

    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}
