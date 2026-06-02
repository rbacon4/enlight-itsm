/**
 * Provider-neutral LLM adapter for the agent loop.
 *
 * The agent works in terms of neutral messages/tools (below); this module
 * translates to/from each provider's native chat+tool-calling API so the loop
 * in `agent.ts` is identical regardless of the configured AI platform.
 *
 * Supported providers:
 *   • anthropic — Claude via @anthropic-ai/sdk
 *   • openai    — GPT via the Chat Completions REST API (raw fetch, no SDK)
 */

import Anthropic from '@anthropic-ai/sdk';
import type { AIProvider } from '@enlight/shared';

/**
 * Deploy-time default AI platform from the AI_PROVIDER env var. Used as the
 * fallback when an org hasn't explicitly chosen a platform in Settings → AI Keys
 * (lets the deploy tool seed the choice). Returns undefined if unset/invalid.
 */
export function envDefaultProvider(): AIProvider | undefined {
  const v = process.env['AI_PROVIDER'];
  return v === 'openai' || v === 'anthropic' ? v : undefined;
}

// ── Neutral types ──────────────────────────────────────────────────────────

export interface LlmToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type LlmMessage =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; toolCalls: LlmToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };

export interface LlmTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface LlmCompletion {
  text: string;
  toolCalls: LlmToolCall[];
  stopReason: 'end' | 'tools';
  usage: { inputTokens: number; outputTokens: number };
}

export interface LlmRequest {
  provider: AIProvider;
  model: string;
  apiKey: string;
  system: string;
  messages: LlmMessage[];
  tools: LlmTool[];
  maxTokens?: number;
}

/** Convert Anthropic-format agent tool definitions into the neutral shape. */
export function toLlmTools(
  defs: { name: string; description?: string; input_schema: unknown }[],
): LlmTool[] {
  return defs.map((d) => ({
    name: d.name,
    description: d.description ?? '',
    inputSchema: (d.input_schema ?? {}) as Record<string, unknown>,
  }));
}

// ── Entry point ────────────────────────────────────────────────────────────

export async function runLlmCompletion(req: LlmRequest): Promise<LlmCompletion> {
  return req.provider === 'openai' ? runOpenAI(req) : runAnthropic(req);
}

// ── Anthropic ──────────────────────────────────────────────────────────────

export function toAnthropicMessages(messages: LlmMessage[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  let pendingToolResults: Anthropic.ToolResultBlockParam[] = [];

  const flushToolResults = () => {
    if (pendingToolResults.length > 0) {
      out.push({ role: 'user', content: pendingToolResults });
      pendingToolResults = [];
    }
  };

  for (const m of messages) {
    if (m.role === 'tool') {
      // Consecutive tool results are merged into one user message (Anthropic rule).
      pendingToolResults.push({
        type: 'tool_result',
        tool_use_id: m.toolCallId,
        content: m.content,
      });
      continue;
    }
    flushToolResults();
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.text });
    } else {
      const blocks: Anthropic.ContentBlockParam[] = [];
      if (m.text.trim()) blocks.push({ type: 'text', text: m.text });
      for (const tc of m.toolCalls) {
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
      }
      out.push({ role: 'assistant', content: blocks.length ? blocks : m.text || '…' });
    }
  }
  flushToolResults();
  return out;
}

async function runAnthropic(req: LlmRequest): Promise<LlmCompletion> {
  const client = new Anthropic({ apiKey: req.apiKey });
  const response = await client.messages.create({
    model: req.model,
    max_tokens: req.maxTokens ?? 4096,
    // Omit system/tools when empty so simple (no-tool) completions work too.
    ...(req.system.trim() ? { system: req.system } : {}),
    ...(req.tools.length > 0
      ? {
          tools: req.tools.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
          })),
        }
      : {}),
    messages: toAnthropicMessages(req.messages),
  });

  let text = '';
  const toolCalls: LlmToolCall[] = [];
  for (const block of response.content) {
    if (block.type === 'text') text += block.text;
    else if (block.type === 'tool_use') {
      toolCalls.push({ id: block.id, name: block.name, input: block.input as Record<string, unknown> });
    }
  }

  return {
    text,
    toolCalls,
    stopReason: response.stop_reason === 'tool_use' ? 'tools' : 'end',
    usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
  };
}

// ── OpenAI (Chat Completions REST) ───────────────────────────────────────────

interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}
interface OpenAIResponse {
  choices: { message: { content: string | null; tool_calls?: OpenAIToolCall[] }; finish_reason: string }[];
  usage?: { prompt_tokens: number; completion_tokens: number };
}

export function toOpenAIMessages(system: string, messages: LlmMessage[]): unknown[] {
  const out: unknown[] = system.trim() ? [{ role: 'system', content: system }] : [];
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.text });
    } else if (m.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content });
    } else {
      const msg: Record<string, unknown> = { role: 'assistant', content: m.text || null };
      if (m.toolCalls.length > 0) {
        msg['tool_calls'] = m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.input) },
        }));
      }
      out.push(msg);
    }
  }
  return out;
}

async function runOpenAI(req: LlmRequest): Promise<LlmCompletion> {
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${req.apiKey}` },
    body: JSON.stringify({
      model: req.model,
      max_tokens: req.maxTokens ?? 4096,
      messages: toOpenAIMessages(req.system, req.messages),
      // Only send tools/tool_choice when there are tools (OpenAI rejects an empty array).
      ...(req.tools.length > 0
        ? {
            tools: req.tools.map((t) => ({
              type: 'function',
              function: { name: t.name, description: t.description, parameters: t.inputSchema },
            })),
            tool_choice: 'auto',
          }
        : {}),
    }),
  });

  if (!resp.ok) {
    throw new Error(`OpenAI chat error ${resp.status}: ${(await resp.text()).slice(0, 500)}`);
  }

  const json = (await resp.json()) as OpenAIResponse;
  const choice = json.choices?.[0];
  const message = choice?.message;

  const toolCalls: LlmToolCall[] = (message?.tool_calls ?? []).map((tc) => {
    let input: Record<string, unknown> = {};
    try { input = JSON.parse(tc.function.arguments || '{}'); } catch { /* leave empty */ }
    return { id: tc.id, name: tc.function.name, input };
  });

  return {
    text: message?.content ?? '',
    toolCalls,
    stopReason: choice?.finish_reason === 'tool_calls' ? 'tools' : 'end',
    usage: {
      inputTokens: json.usage?.prompt_tokens ?? 0,
      outputTokens: json.usage?.completion_tokens ?? 0,
    },
  };
}
