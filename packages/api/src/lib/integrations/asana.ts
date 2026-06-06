/**
 * Asana adapter.
 *
 * Uses Asana REST API v1 (https://developers.asana.com/reference/rest-api-reference).
 * Authentication: Personal Access Token (Bearer).
 *
 * Two-way sync:
 *   Outbound: create/update tasks via REST.
 *   Inbound:  Asana webhooks POST to /api/webhooks/asana/:integrationId.
 *             Asana sends a handshake GET with X-Hook-Secret on registration.
 */

import type { AsanaConfig, ExternalTicket, SyncResult } from './types.js';

const BASE = 'https://app.asana.com/api/1.0';

async function asanaFetch(
  cfg: AsanaConfig,
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${cfg.accessToken}`,
      ...(options.headers ?? {}),
    },
    signal: AbortSignal.timeout(15_000),
  });
}

function mapPriorityToTag(priority: string): string {
  // Asana doesn't have a native priority — we encode it in the task name prefix.
  // Optionally use custom fields if configured.
  const map: Record<string, string> = {
    critical: '[CRITICAL] ',
    high: '[HIGH] ',
    medium: '',
    low: '[LOW] ',
  };
  return map[priority] ?? '';
}

/** Verify credentials and project GID. Returns an error string or null. */
export async function testAsanaConnection(cfg: AsanaConfig): Promise<string | null> {
  try {
    const res = await asanaFetch(cfg, `/projects/${cfg.projectGid}`);
    if (res.status === 200) return null;
    if (res.status === 401) return 'Invalid access token.';
    if (res.status === 404) return `Project GID "${cfg.projectGid}" not found.`;
    return `Asana returned HTTP ${res.status}.`;
  } catch (e) {
    return `Connection failed: ${(e as Error).message}`;
  }
}

/** Create an Asana task from an Enlight request. */
export async function createAsanaTask(
  cfg: AsanaConfig,
  ticket: { title: string; description: string; priority: string },
): Promise<SyncResult> {
  const prefix = mapPriorityToTag(ticket.priority);
  const body = {
    data: {
      name: `${prefix}${ticket.title}`,
      notes: ticket.description || '',
      projects: [cfg.projectGid],
      workspace: cfg.workspaceGid,
    },
  };

  const res = await asanaFetch(cfg, '/tasks', {
    method: 'POST',
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Asana create failed (${res.status}): ${err}`);
  }

  const data = (await res.json()) as { data: { gid: string; permalink_url: string } };
  return {
    externalId: data.data.gid,
    externalUrl: data.data.permalink_url,
  };
}

/** Update an Asana task's name and notes. */
export async function updateAsanaTask(
  cfg: AsanaConfig,
  taskGid: string,
  ticket: { title?: string; description?: string; priority?: string },
): Promise<void> {
  const updates: Record<string, unknown> = {};
  if (ticket.title !== undefined) {
    const prefix = ticket.priority ? mapPriorityToTag(ticket.priority) : '';
    updates['name'] = `${prefix}${ticket.title}`;
  }
  if (ticket.description !== undefined) updates['notes'] = ticket.description;

  if (Object.keys(updates).length === 0) return;

  const res = await asanaFetch(cfg, `/tasks/${taskGid}`, {
    method: 'PUT',
    body: JSON.stringify({ data: updates }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Asana update failed (${res.status}): ${err}`);
  }
}

/** Move an Asana task to a section (status routing) or mark completed. */
export async function transitionAsanaTask(
  cfg: AsanaConfig,
  taskGid: string,
  enlightStatus: string,
): Promise<void> {
  const isResolved = enlightStatus === 'resolved' || enlightStatus === 'closed';
  const sectionGid = cfg.statusSectionMap?.[enlightStatus];

  // Mark task complete/incomplete based on resolution state
  await asanaFetch(cfg, `/tasks/${taskGid}`, {
    method: 'PUT',
    body: JSON.stringify({ data: { completed: isResolved } }),
  });

  // Optionally move to a section
  if (sectionGid) {
    await asanaFetch(cfg, `/sections/${sectionGid}/addTask`, {
      method: 'POST',
      body: JSON.stringify({ data: { task: taskGid } }),
    });
  }
}

/** Fetch an Asana task (for inbound sync). */
export async function getAsanaTask(
  cfg: AsanaConfig,
  taskGid: string,
): Promise<ExternalTicket | null> {
  const res = await asanaFetch(
    cfg,
    `/tasks/${taskGid}?opt_fields=name,notes,completed,permalink_url`,
  );
  if (!res.ok) return null;

  const data = (await res.json()) as {
    data: { gid: string; name: string; notes: string; completed: boolean; permalink_url: string };
  };

  return {
    id: data.data.gid,
    url: data.data.permalink_url,
    title: data.data.name,
    description: data.data.notes,
    status: data.data.completed ? 'completed' : 'active',
  };
}

/** Add a comment (story) to an Asana task. */
export async function addAsanaComment(
  cfg: AsanaConfig,
  taskGid: string,
  text: string,
): Promise<void> {
  await asanaFetch(cfg, `/tasks/${taskGid}/stories`, {
    method: 'POST',
    body: JSON.stringify({ data: { text } }),
  });
}
