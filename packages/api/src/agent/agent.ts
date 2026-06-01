import Anthropic from '@anthropic-ai/sdk';
import { db } from '../db/client.js';
import { requests, projects, comments, aiActions, users, organizations } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { agentToolDefinitions, executeTool } from './tools.js';
import { logger } from '../lib/logger.js';
import { makeSlackClient } from '../slack/client.js';
import { decryptOrgSettings } from '../lib/secretCrypto.js';
import type { AIModel, OrganizationSettings } from '@enlight/shared';

function makeAnthropicClient(orgSettings?: OrganizationSettings) {
  const apiKey = orgSettings?.anthropicApiKey || process.env['ANTHROPIC_API_KEY'];
  if (!apiKey) throw new Error('Anthropic API key not set. Add it in Settings → AI Keys or set ANTHROPIC_API_KEY in your environment.');
  return new Anthropic({ apiKey });
}

const DEFAULT_SYSTEM_PROMPT = `You are Enlight, an AI-powered IT service management assistant.
Your role is to help users submit and track IT support requests, and to assist support agents
in triaging and resolving those requests efficiently.

When a new request comes in:
1. Review the request details carefully
2. Classify it by category and set an appropriate priority
3. Search the knowledge base for relevant information
4. Either resolve it directly if you have enough information, or route it to the right agent

Always be professional, concise, and helpful. Cite knowledge base sources when you use them.`;

export interface AgentContext {
  requestId: string;
  projectId: string;
  triggerType: 'triage' | 'comment_received' | 'slack_message';
  userMessage?: string;
  slackUserId?: string;
  /** Role of the user who created the request. When provided the agent uses it
   *  directly; otherwise it falls back to a DB lookup. */
  requesterRole?: string;
}

export async function runAgentTurn(ctx: AgentContext): Promise<void> {
  const [request] = await db
    .select()
    .from(requests)
    .where(eq(requests.id, ctx.requestId))
    .limit(1);

  if (!request) {
    logger.warn('Agent: request not found', { requestId: ctx.requestId });
    return;
  }

  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, ctx.projectId))
    .limit(1);

  if (!project) {
    logger.warn('Agent: project not found', { projectId: ctx.projectId });
    return;
  }

  // Resolve org settings for per-org API key override
  const [orgRow] = await db
    .select({ settings: organizations.settings })
    .from(organizations)
    .where(eq(organizations.id, project.orgId))
    .limit(1);

  const orgSettings = decryptOrgSettings((orgRow?.settings ?? {}) as OrganizationSettings);
  const anthropic = makeAnthropicClient(orgSettings);

  // Find or auto-create a system agent user for this org
  const AGENT_EMAIL = 'enlight-agent@system.internal';
  let agentUserId: string;
  {
    const [existing] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, AGENT_EMAIL))
      .limit(1);

    if (existing) {
      agentUserId = existing.id;
    } else {
      const [created] = await db
        .insert(users)
        .values({
          orgId: project.orgId,
          email: AGENT_EMAIL,
          name: 'Enlight AI',
          globalRole: 'agent',
        })
        .onConflictDoNothing()
        .returning({ id: users.id });
      // Re-fetch in case onConflictDoNothing swallowed a race
      const [refetch] = created
        ? [created]
        : await db.select({ id: users.id }).from(users).where(eq(users.email, AGENT_EMAIL)).limit(1);
      agentUserId = refetch?.id ?? '';
    }
  }

  const requestComments = await db
    .select()
    .from(comments)
    .where(eq(comments.requestId, ctx.requestId))
    .orderBy(comments.createdAt);

  const systemPrompt = [
    project.aiInstructions ?? DEFAULT_SYSTEM_PROMPT,
    `\nCurrent request ID: ${request.id}`,
    `Project: ${project.name}`,
    `Autonomous mode: ${project.aiAutonomousMode ? 'enabled' : 'disabled (draft responses for agent review)'}`,
  ].join('\n');

  const conversationHistory: Anthropic.MessageParam[] = [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: `New support request:\n\nTitle: ${request.title}\nPriority: ${request.priority}\nStatus: ${request.status}\n\nDescription:\n${request.description}`,
        },
      ],
    },
  ];

  // Add existing comments as conversation context
  for (const comment of requestComments) {
    conversationHistory.push({
      role: comment.aiGenerated ? 'assistant' : 'user',
      content: comment.body,
    });
  }

  if (ctx.userMessage) {
    conversationHistory.push({ role: 'user', content: ctx.userMessage });
  }

  // ── Slack "thinking" indicator ─────────────────────────────────────────────
  // Post a ⏳ status message in the thread as soon as the job starts so the
  // user knows the agent is working.  We'll update it in-place with the real
  // response when the turn completes, or delete it on failure / no-send.
  let thinkingMsgTs: string | undefined;
  {
    const slackIndicator = makeSlackClient(orgSettings);
    if (slackIndicator && request.slackUserId && request.slackThreadTs) {
      try {
        const result = await slackIndicator.chat.postMessage({
          channel: request.slackUserId,
          thread_ts: request.slackThreadTs,
          text: '⏳ Working on it…',
        });
        if (result.ts) thinkingMsgTs = result.ts;
      } catch (err) {
        logger.debug('Could not post thinking indicator to Slack', { err });
      }
    }
  }

  let inputTokensTotal = 0;
  let outputTokensTotal = 0;

  // Agentic loop (wrapped so we can clean up the thinking indicator in finally)
  try {
  let continueLoop = true;
  while (continueLoop) {
    const response = await anthropic.messages.create({
      model: project.aiModel as AIModel,
      max_tokens: 4096,
      system: systemPrompt,
      tools: agentToolDefinitions,
      messages: conversationHistory,
    });

    inputTokensTotal += response.usage.input_tokens;
    outputTokensTotal += response.usage.output_tokens;

    conversationHistory.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'end_turn') {
      // Extract text response and save as AI-generated comment
      const textBlock = response.content.find((b) => b.type === 'text');
      if (textBlock?.type === 'text' && textBlock.text && agentUserId) {
        const shouldPost = project.aiAutonomousMode || ctx.triggerType === 'triage';
        if (shouldPost) {
          await db.insert(comments).values({
            requestId: ctx.requestId,
            authorId: agentUserId,
            body: textBlock.text,
            isInternal: false,
            aiGenerated: true,
          });

          // Deliver to requester via Slack DM
          try {
            if (request.slackUserId) {
              const slack = makeSlackClient(orgSettings);
              if (slack) {
                if (thinkingMsgTs) {
                  // Update the ⏳ indicator in-place with the real response
                  await slack.chat.update({
                    channel: request.slackUserId,
                    ts: thinkingMsgTs,
                    text: textBlock.text,
                  });
                  thinkingMsgTs = undefined; // consumed — skip cleanup in finally
                } else if (request.slackThreadTs) {
                  await slack.chat.postMessage({
                    channel: request.slackUserId,
                    thread_ts: request.slackThreadTs,
                    text: textBlock.text,
                  });
                } else {
                  const result = await slack.chat.postMessage({
                    channel: request.slackUserId,
                    text: textBlock.text,
                  });
                  // Save thread ts so future replies are threaded
                  if (result.ts) {
                    await db.update(requests)
                      .set({ slackThreadTs: result.ts as string, updatedAt: new Date() })
                      .where(eq(requests.id, ctx.requestId));
                  }
                }
                logger.info('AI response delivered to Slack', { requestId: ctx.requestId, slackUserId: request.slackUserId });
              } else {
                logger.debug('No Slack token configured — skipping DM delivery', { requestId: ctx.requestId });
              }
            }
          } catch (slackErr) {
            logger.warn('Failed to deliver AI response via Slack', { slackErr });
          }
        }
      }
      continueLoop = false;
    } else if (response.stop_reason === 'tool_use') {
      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;

        logger.debug('Agent tool call', { tool: block.name, input: block.input });

        const result = await executeTool(
          block.name,
          block.input as Parameters<typeof executeTool>[1],
          agentUserId,
          orgSettings,
        );

        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(result),
        });
      }

      conversationHistory.push({ role: 'user', content: toolResults });
    } else {
      continueLoop = false;
    }
  }
  } finally {
    // If the thinking indicator was never replaced (agent produced no sendable
    // response, autonomous mode was off, or an error occurred), remove it so
    // it doesn't linger as a dangling ⏳ in the thread.
    if (thinkingMsgTs && request.slackUserId) {
      try {
        const slack = makeSlackClient(orgSettings);
        if (slack) {
          await slack.chat.delete({ channel: request.slackUserId, ts: thinkingMsgTs });
        }
      } catch { /* non-fatal — best-effort cleanup */ }
    }
  }

  // Log the AI action for auditability
  await db.insert(aiActions).values({
    requestId: ctx.requestId,
    actionType: ctx.triggerType,
    model: project.aiModel,
    inputTokens: inputTokensTotal,
    outputTokens: outputTokensTotal,
  });

  logger.info('Agent turn complete', {
    requestId: ctx.requestId,
    inputTokens: inputTokensTotal,
    outputTokens: outputTokensTotal,
  });
}
