import type Anthropic from '@anthropic-ai/sdk';
import { db } from '../db/client.js';
import {
  requests,
  comments,
  knowledgeChunks,
  knowledgeSources,
  users,
  projects,
  ripplingWorkers,
  jumpcloudUsers,
  oktaUsers,
} from '../db/schema.js';
import { eq, and, inArray, sql } from 'drizzle-orm';
import type { RequestPriority, RequestStatus, OrganizationSettings } from '@enlight/shared';
import { embedText, type EmbeddingKeyOverrides } from '../lib/embeddings.js';

/** Returns true when an embedding API key is actually configured. */
function hasEmbeddingKey(overrides: EmbeddingKeyOverrides): boolean {
  const provider = overrides.embeddingProvider ?? process.env['EMBEDDING_PROVIDER'] ?? 'voyage';
  if (provider === 'openai') return !!(overrides.openAiApiKey ?? process.env['OPENAI_API_KEY']);
  return !!(overrides.voyageApiKey ?? process.env['VOYAGE_API_KEY']);
}
import { logger } from '../lib/logger.js';
import { makeSlackClient } from '../slack/client.js';
import { createOffboardingEvent, validateOffboardingInput } from '../lib/offboarding.js';
import { offboardingQueue } from '../queues/index.js';
import { computeOnCall } from '../lib/oncall.js';
import { oncallSchedules } from '../db/schema.js';
import { makeRipplingClient } from '../lib/rippling.js';
import { makeJumpCloudClient } from '../lib/jumpcloud.js';
import { makeOktaClient } from '../lib/okta.js';

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
  {
    name: 'rippling_lookup_worker',
    description: 'Look up an employee in Rippling IT by work email. Returns name, department, title, employment status, and Rippling ID.',
    input_schema: {
      type: 'object',
      properties: { email: { type: 'string', description: 'Work email address to look up' } },
      required: ['email'],
    },
  },
  {
    name: 'jumpcloud_lookup_user',
    description: 'Look up an employee in JumpCloud by work email. Returns username, department, title, suspended status, and JumpCloud ID.',
    input_schema: {
      type: 'object',
      properties: { email: { type: 'string', description: 'Work email address to look up' } },
      required: ['email'],
    },
  },
  {
    name: 'okta_lookup_user',
    description: 'Look up an employee in Okta by email or login. Returns profile, status, department, and Okta ID.',
    input_schema: {
      type: 'object',
      properties: { email: { type: 'string', description: 'Email address or Okta login to look up' } },
      required: ['email'],
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
      const topK = input.topK ?? 5;
      const cols = {
        id: knowledgeChunks.id,
        title: knowledgeChunks.title,
        body: knowledgeChunks.body,
        sourceUrl: knowledgeChunks.sourceUrl,
        metadata: knowledgeChunks.metadata,
      };

      if (hasEmbeddingKey(embeddingOverrides)) {
        // ── Vector search (semantic) ──────────────────────────────────────────
        try {
          const queryEmbedding = await embedText(input.query!, embeddingOverrides);
          const vecLiteral = `[${queryEmbedding.join(',')}]`;
          return await db
            .select(cols)
            .from(knowledgeChunks)
            .innerJoin(knowledgeSources, eq(knowledgeSources.id, knowledgeChunks.sourceId))
            .where(
              and(
                eq(knowledgeSources.projectId, input.projectId!),
                sql`${knowledgeChunks.embedding} IS NOT NULL`,
              ),
            )
            .orderBy(sql`${knowledgeChunks.embedding} <=> ${vecLiteral}::vector`)
            .limit(topK);
        } catch (err) {
          logger.warn('Vector KB search failed, falling back to full-text search', { err });
          // fall through to FTS below
        }
      }

      // ── Full-text search fallback (no embedding key, or vector search failed) ─
      try {
        const query = input.query!;
        return await db
          .select(cols)
          .from(knowledgeChunks)
          .innerJoin(knowledgeSources, eq(knowledgeSources.id, knowledgeChunks.sourceId))
          .where(
            and(
              eq(knowledgeSources.projectId, input.projectId!),
              sql`${knowledgeChunks.searchVector} @@ websearch_to_tsquery('english', ${query})`,
            ),
          )
          .orderBy(sql`ts_rank(${knowledgeChunks.searchVector}, websearch_to_tsquery('english', ${query})) DESC`)
          .limit(topK);
      } catch (err) {
        logger.warn('KB search unavailable', { err });
        return { results: [], note: 'Knowledge base search is unavailable. Proceeding without KB context.' };
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

    case 'rippling_lookup_worker': {
      const email = (input['email'] as string | undefined) ?? '';
      if (!email) return { error: 'email is required' };
      try {
        // Check local DB first
        const [proj] = await db.select({ orgId: projects.orgId }).from(projects).where(eq(projects.id, input.projectId ?? '')).limit(1);
        const orgId = proj?.orgId;
        if (orgId) {
          const [row] = await db.select().from(ripplingWorkers)
            .where(and(eq(ripplingWorkers.orgId, orgId), eq(ripplingWorkers.workEmail, email.toLowerCase())))
            .limit(1);
          if (row) {
            return { found: true, ripplingId: row.ripplingId, displayName: row.displayName, workEmail: row.workEmail, department: row.department, title: row.title, employmentStatus: row.employmentStatus };
          }
        }
        // Fall through to live API
        const client = makeRipplingClient(orgSettings);
        const page = await client.listWorkers();
        const found = page.data.find(w => w.workEmail.toLowerCase() === email.toLowerCase());
        if (!found) return { found: false, email };
        return { found: true, ripplingId: found.id, displayName: `${found.name.firstName} ${found.name.lastName}`, workEmail: found.workEmail, department: found.department, title: found.title, employmentStatus: found.employmentStatus };
      } catch (err) {
        logger.warn('rippling_lookup_worker failed', { email, err });
        return { found: false, email, error: err instanceof Error ? err.message : String(err) };
      }
    }

    case 'jumpcloud_lookup_user': {
      const email = (input['email'] as string | undefined) ?? '';
      if (!email) return { error: 'email is required' };
      try {
        const [proj] = await db.select({ orgId: projects.orgId }).from(projects).where(eq(projects.id, input.projectId ?? '')).limit(1);
        const orgId = proj?.orgId;
        if (orgId) {
          const [row] = await db.select().from(jumpcloudUsers)
            .where(and(eq(jumpcloudUsers.orgId, orgId), eq(jumpcloudUsers.workEmail, email.toLowerCase())))
            .limit(1);
          if (row) {
            return { found: true, jumpcloudId: row.jumpcloudId, username: row.username, displayName: row.displayName, workEmail: row.workEmail, department: row.department, title: row.title, suspended: row.suspended, employmentStatus: row.employmentStatus };
          }
        }
        const client = makeJumpCloudClient(orgSettings, orgId);
        const page = await client.listUsers();
        const found = page.results.find(u => u.email.toLowerCase() === email.toLowerCase());
        if (!found) return { found: false, email };
        return { found: true, jumpcloudId: found.id, username: found.username, workEmail: found.email, department: found.department, title: found.jobTitle, suspended: found.suspended };
      } catch (err) {
        logger.warn('jumpcloud_lookup_user failed', { email, err });
        return { found: false, email, error: err instanceof Error ? err.message : String(err) };
      }
    }

    case 'okta_lookup_user': {
      const email = (input['email'] as string | undefined) ?? '';
      if (!email) return { error: 'email is required' };
      try {
        const [proj] = await db.select({ orgId: projects.orgId }).from(projects).where(eq(projects.id, input.projectId ?? '')).limit(1);
        const orgId = proj?.orgId;
        if (orgId) {
          const [row] = await db.select().from(oktaUsers)
            .where(and(eq(oktaUsers.orgId, orgId), sql`(${oktaUsers.email} = ${email.toLowerCase()} OR ${oktaUsers.login} = ${email.toLowerCase()})`))
            .limit(1);
          if (row) {
            return { found: true, oktaId: row.oktaId, login: row.login, email: row.email, displayName: row.displayName, department: row.department, title: row.title, status: row.status };
          }
        }
        const client = makeOktaClient(orgSettings, orgId);
        const user = await client.getUser(email);
        if (!user) return { found: false, email };
        return { found: true, oktaId: user.id, login: user.profile.login, email: user.profile.email, displayName: user.profile.displayName, department: user.profile.department, title: user.profile.title, status: user.status };
      } catch (err) {
        logger.warn('okta_lookup_user failed', { email, err });
        return { found: false, email, error: err instanceof Error ? err.message : String(err) };
      }
    }

    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}
