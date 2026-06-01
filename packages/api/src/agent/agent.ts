import { db } from '../db/client.js';
import { requests, projects, comments, aiActions, users, organizations } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { agentToolDefinitions, executeTool } from './tools.js';
import { runLlmCompletion, toLlmTools, type LlmMessage } from './llm.js';
import { logger } from '../lib/logger.js';
import { makeSlackClient } from '../slack/client.js';
import { decryptOrgSettings } from '../lib/secretCrypto.js';
import type { AIProvider, OrganizationSettings } from '@enlight/shared';

const DEFAULT_OPENAI_MODEL = 'gpt-4o';
const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-4-5';
const OPENAI_MODELS = new Set(['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini']);
const CLAUDE_MODELS = new Set(['claude-opus-4-5', 'claude-sonnet-4-5', 'claude-haiku-4-5']);

/**
 * Resolve the active AI platform, model, and API key for an org.
 *
 * The model is the project's `aiModel` for BOTH platforms (per-project parity).
 * If the stored model doesn't belong to the active provider's family — e.g. the
 * org switched platform but a project still has a Claude model saved — we fall
 * back to that provider's default so a turn never fails on a mismatched model.
 */
function resolveLlm(orgSettings: OrganizationSettings, projectModel: string): {
  provider: AIProvider; model: string; apiKey: string;
} {
  const provider: AIProvider = orgSettings.aiProvider ?? 'anthropic';
  if (provider === 'openai') {
    const apiKey = orgSettings.openAiApiKey || process.env['OPENAI_API_KEY'];
    if (!apiKey) throw new Error('OpenAI API key not set. Add it in Settings → AI Keys or set OPENAI_API_KEY in your environment.');
    const model = OPENAI_MODELS.has(projectModel) ? projectModel : DEFAULT_OPENAI_MODEL;
    return { provider, model, apiKey };
  }
  const apiKey = orgSettings.anthropicApiKey || process.env['ANTHROPIC_API_KEY'];
  if (!apiKey) throw new Error('Anthropic API key not set. Add it in Settings → AI Keys or set ANTHROPIC_API_KEY in your environment.');
  const model = CLAUDE_MODELS.has(projectModel) ? projectModel : DEFAULT_CLAUDE_MODEL;
  return { provider, model, apiKey };
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
  const llm = resolveLlm(orgSettings, project.aiModel);
  const llmTools = toLlmTools(agentToolDefinitions);

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

  const conversationHistory: LlmMessage[] = [
    {
      role: 'user',
      text: `New support request:\n\nTitle: ${request.title}\nPriority: ${request.priority}\nStatus: ${request.status}\n\nDescription:\n${request.description}`,
    },
  ];

  // Add existing comments as conversation context
  for (const comment of requestComments) {
    if (comment.aiGenerated) {
      conversationHistory.push({ role: 'assistant', text: comment.body, toolCalls: [] });
    } else {
      conversationHistory.push({ role: 'user', text: comment.body });
    }
  }

  if (ctx.userMessage) {
    conversationHistory.push({ role: 'user', text: ctx.userMessage });
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
    const response = await runLlmCompletion({
      provider: llm.provider,
      model: llm.model,
      apiKey: llm.apiKey,
      system: systemPrompt,
      tools: llmTools,
      messages: conversationHistory,
      maxTokens: 4096,
    });

    inputTokensTotal += response.usage.inputTokens;
    outputTokensTotal += response.usage.outputTokens;

    conversationHistory.push({ role: 'assistant', text: response.text, toolCalls: response.toolCalls });

    if (response.stopReason === 'end') {
      // Use the model's text response and save as an AI-generated comment
      const responseText = response.text;
      if (responseText && agentUserId) {
        const shouldPost = project.aiAutonomousMode || ctx.triggerType === 'triage';
        if (shouldPost) {
          await db.insert(comments).values({
            requestId: ctx.requestId,
            authorId: agentUserId,
            body: responseText,
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
                    text: responseText,
                  });
                  thinkingMsgTs = undefined; // consumed — skip cleanup in finally
                } else if (request.slackThreadTs) {
                  await slack.chat.postMessage({
                    channel: request.slackUserId,
                    thread_ts: request.slackThreadTs,
                    text: responseText,
                  });
                } else {
                  const result = await slack.chat.postMessage({
                    channel: request.slackUserId,
                    text: responseText,
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
    } else if (response.stopReason === 'tools' && response.toolCalls.length > 0) {
      for (const call of response.toolCalls) {
        logger.debug('Agent tool call', { tool: call.name, input: call.input });

        const result = await executeTool(
          call.name,
          call.input as Parameters<typeof executeTool>[1],
          agentUserId,
          orgSettings,
        );

        conversationHistory.push({
          role: 'tool',
          toolCallId: call.id,
          content: JSON.stringify(result),
        });
      }
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

  // Log the AI action for auditability (records the model actually used)
  await db.insert(aiActions).values({
    requestId: ctx.requestId,
    actionType: ctx.triggerType,
    model: llm.model,
    inputTokens: inputTokensTotal,
    outputTokens: outputTokensTotal,
  });

  logger.info('Agent turn complete', {
    requestId: ctx.requestId,
    inputTokens: inputTokensTotal,
    outputTokens: outputTokensTotal,
  });
}
