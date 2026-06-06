/**
 * Linear adapter.
 *
 * Uses Linear GraphQL API (https://developers.linear.app/docs/graphql/working-with-the-graphql-api).
 * Authentication: API key (Bearer).
 *
 * Two-way sync:
 *   Outbound: create/update issues via GraphQL mutations.
 *   Inbound:  Linear webhooks POST to /api/webhooks/linear/:integrationId.
 */

import type { LinearConfig, ExternalTicket, SyncResult } from './types.js';

const GQL_URL = 'https://api.linear.app/graphql';

async function linearQuery<T>(
  cfg: LinearConfig,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const res = await fetch(GQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: cfg.apiKey,
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    throw new Error(`Linear API error: HTTP ${res.status}`);
  }

  const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (json.errors?.length) {
    throw new Error(`Linear GraphQL error: ${json.errors.map((e) => e.message).join(', ')}`);
  }
  return json.data as T;
}

function mapPriority(priority: string): number {
  // Linear: 0=No priority, 1=Urgent, 2=High, 3=Medium, 4=Low
  const map: Record<string, number> = { critical: 1, high: 2, medium: 3, low: 4 };
  return map[priority] ?? 3;
}

/** Verify API key and team ID. Returns an error string or null. */
export async function testLinearConnection(cfg: LinearConfig): Promise<string | null> {
  try {
    const data = await linearQuery<{ team: { id: string } | null }>(
      cfg,
      `query($id: String!) { team(id: $id) { id } }`,
      { id: cfg.teamId },
    );
    if (data.team) return null;
    return `Team ID "${cfg.teamId}" not found.`;
  } catch (e) {
    return `Connection failed: ${(e as Error).message}`;
  }
}

/** Resolve a state name to its Linear state ID for a given team. */
async function resolveStateId(cfg: LinearConfig, stateName: string): Promise<string | null> {
  const data = await linearQuery<{
    workflowStates: { nodes: { id: string; name: string; team: { id: string } }[] };
  }>(
    cfg,
    `query($teamId: ID!) {
      workflowStates(filter: { team: { id: { eq: $teamId } } }) {
        nodes { id name team { id } }
      }
    }`,
    { teamId: cfg.teamId },
  );

  const state = data.workflowStates.nodes.find(
    (s) => s.name.toLowerCase() === stateName.toLowerCase(),
  );
  return state?.id ?? null;
}

/** Create a Linear issue from an Enlight request. */
export async function createLinearIssue(
  cfg: LinearConfig,
  ticket: { title: string; description: string; priority: string },
): Promise<SyncResult> {
  const data = await linearQuery<{
    issueCreate: { success: boolean; issue: { id: string; identifier: string; url: string } };
  }>(
    cfg,
    `mutation($input: IssueCreateInput!) {
      issueCreate(input: $input) {
        success
        issue { id identifier url }
      }
    }`,
    {
      input: {
        teamId: cfg.teamId,
        title: ticket.title,
        description: ticket.description || '',
        priority: mapPriority(ticket.priority),
      },
    },
  );

  if (!data.issueCreate.success) throw new Error('Linear issue creation failed');

  return {
    externalId: data.issueCreate.issue.id,
    externalUrl: data.issueCreate.issue.url,
  };
}

/** Update a Linear issue's title and description. */
export async function updateLinearIssue(
  cfg: LinearConfig,
  issueId: string,
  ticket: { title?: string; description?: string; priority?: string },
): Promise<void> {
  const input: Record<string, unknown> = {};
  if (ticket.title !== undefined) input['title'] = ticket.title;
  if (ticket.description !== undefined) input['description'] = ticket.description;
  if (ticket.priority !== undefined) input['priority'] = mapPriority(ticket.priority);

  if (Object.keys(input).length === 0) return;

  await linearQuery(
    cfg,
    `mutation($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) { success }
    }`,
    { id: issueId, input },
  );
}

/** Transition a Linear issue to a new state by name. */
export async function transitionLinearIssue(
  cfg: LinearConfig,
  issueId: string,
  enlightStatus: string,
): Promise<void> {
  const targetStateName = cfg.statusMap?.[enlightStatus];
  if (!targetStateName) return;

  const stateId = await resolveStateId(cfg, targetStateName);
  if (!stateId) return;

  await linearQuery(
    cfg,
    `mutation($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) { success }
    }`,
    { id: issueId, input: { stateId } },
  );
}

/** Fetch a Linear issue (for inbound sync). */
export async function getLinearIssue(
  cfg: LinearConfig,
  issueId: string,
): Promise<ExternalTicket | null> {
  try {
    const data = await linearQuery<{
      issue: {
        id: string;
        identifier: string;
        title: string;
        description: string;
        url: string;
        state: { name: string };
        priority: number;
      } | null;
    }>(
      cfg,
      `query($id: String!) {
        issue(id: $id) {
          id identifier title description url
          state { name }
          priority
        }
      }`,
      { id: issueId },
    );

    if (!data.issue) return null;

    return {
      id: data.issue.id,
      url: data.issue.url,
      title: data.issue.title,
      description: data.issue.description ?? '',
      status: data.issue.state.name,
    };
  } catch {
    return null;
  }
}

/** Add a comment to a Linear issue. */
export async function addLinearComment(
  cfg: LinearConfig,
  issueId: string,
  body: string,
): Promise<void> {
  await linearQuery(
    cfg,
    `mutation($input: CommentCreateInput!) {
      commentCreate(input: $input) { success }
    }`,
    { input: { issueId, body } },
  );
}
