/**
 * Jira / Jira Service Management adapter.
 *
 * Uses Jira Cloud REST API v3 (https://developer.atlassian.com/cloud/jira/platform/rest/v3/).
 * Authentication: Basic Auth with email + API token.
 *
 * Two-way sync:
 *   Outbound: create/update issues via REST.
 *   Inbound:  Jira webhooks POST to /api/webhooks/jira/:integrationId.
 */

import type { JiraConfig, ExternalTicket, SyncResult } from './types.js';

function authHeader(cfg: JiraConfig): string {
  return 'Basic ' + Buffer.from(`${cfg.email}:${cfg.apiToken}`).toString('base64');
}

async function jiraFetch(
  cfg: JiraConfig,
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  const url = `${cfg.baseUrl.replace(/\/$/, '')}/rest/api/3${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: authHeader(cfg),
      ...(options.headers ?? {}),
    },
    signal: AbortSignal.timeout(15_000),
  });
  return res;
}

// Convert Enlight priority → Jira priority name
function mapPriority(priority: string): string {
  const map: Record<string, string> = {
    critical: 'Highest',
    high: 'High',
    medium: 'Medium',
    low: 'Low',
  };
  return map[priority] ?? 'Medium';
}

/** Verify credentials and project key. Returns an error string or null. */
export async function testJiraConnection(cfg: JiraConfig): Promise<string | null> {
  try {
    const res = await jiraFetch(cfg, `/project/${cfg.projectKey}`);
    if (res.status === 200) return null;
    if (res.status === 401) return 'Invalid email or API token.';
    if (res.status === 404) return `Project key "${cfg.projectKey}" not found.`;
    return `Jira returned HTTP ${res.status}.`;
  } catch (e) {
    return `Connection failed: ${(e as Error).message}`;
  }
}

/** Create a Jira issue from an Enlight request. */
export async function createJiraIssue(
  cfg: JiraConfig,
  ticket: { title: string; description: string; priority: string },
): Promise<SyncResult> {
  const body = {
    fields: {
      project: { key: cfg.projectKey },
      summary: ticket.title,
      description: {
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: ticket.description || ' ' }],
          },
        ],
      },
      issuetype: { name: cfg.issueType || 'Task' },
      priority: { name: mapPriority(ticket.priority) },
    },
  };

  const res = await jiraFetch(cfg, '/issue', {
    method: 'POST',
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Jira create failed (${res.status}): ${err}`);
  }

  const data = (await res.json()) as { id: string; key: string; self: string };
  const url = `${cfg.baseUrl.replace(/\/$/, '')}/browse/${data.key}`;
  return { externalId: data.key, externalUrl: url };
}

/** Update a Jira issue's summary, description, and priority. */
export async function updateJiraIssue(
  cfg: JiraConfig,
  issueKey: string,
  ticket: { title?: string; description?: string; priority?: string },
): Promise<void> {
  const fields: Record<string, unknown> = {};
  if (ticket.title) fields['summary'] = ticket.title;
  if (ticket.description !== undefined) {
    fields['description'] = {
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: ticket.description || ' ' }],
        },
      ],
    };
  }
  if (ticket.priority) fields['priority'] = { name: mapPriority(ticket.priority) };

  if (Object.keys(fields).length === 0) return;

  const res = await jiraFetch(cfg, `/issue/${issueKey}`, {
    method: 'PUT',
    body: JSON.stringify({ fields }),
  });

  if (!res.ok && res.status !== 204) {
    const err = await res.text();
    throw new Error(`Jira update failed (${res.status}): ${err}`);
  }
}

/** Transition a Jira issue to a new status via named transition. */
export async function transitionJiraIssue(
  cfg: JiraConfig,
  issueKey: string,
  targetStatusName: string,
): Promise<void> {
  // List available transitions
  const res = await jiraFetch(cfg, `/issue/${issueKey}/transitions`);
  if (!res.ok) return;

  const data = (await res.json()) as { transitions: { id: string; name: string }[] };
  const transition = data.transitions.find(
    (t) => t.name.toLowerCase() === targetStatusName.toLowerCase(),
  );
  if (!transition) return; // no matching transition — skip silently

  const tRes = await jiraFetch(cfg, `/issue/${issueKey}/transitions`, {
    method: 'POST',
    body: JSON.stringify({ transition: { id: transition.id } }),
  });

  if (!tRes.ok && tRes.status !== 204) {
    const err = await tRes.text();
    throw new Error(`Jira transition failed (${tRes.status}): ${err}`);
  }
}

/** Fetch a Jira issue (for inbound sync). */
export async function getJiraIssue(
  cfg: JiraConfig,
  issueKey: string,
): Promise<ExternalTicket | null> {
  const res = await jiraFetch(cfg, `/issue/${issueKey}?fields=summary,description,status,priority`);
  if (!res.ok) return null;

  const data = (await res.json()) as {
    key: string;
    fields: {
      summary: string;
      description?: { content?: { content?: { text?: string }[] }[] };
      status: { name: string };
      priority?: { name: string };
    };
  };

  const descText =
    data.fields.description?.content?.[0]?.content
      ?.map((c) => c.text ?? '')
      .join('') ?? '';

  const ticket: ExternalTicket = {
    id: data.key,
    url: `${cfg.baseUrl.replace(/\/$/, '')}/browse/${data.key}`,
    title: data.fields.summary,
    description: descText,
    status: data.fields.status.name,
  };
  if (data.fields.priority?.name) ticket.priority = data.fields.priority.name;
  return ticket;
}

/** Add a comment to a Jira issue. */
export async function addJiraComment(
  cfg: JiraConfig,
  issueKey: string,
  body: string,
): Promise<void> {
  await jiraFetch(cfg, `/issue/${issueKey}/comment`, {
    method: 'POST',
    body: JSON.stringify({
      body: {
        type: 'doc',
        version: 1,
        content: [{ type: 'paragraph', content: [{ type: 'text', text: body }] }],
      },
    }),
  });
}
