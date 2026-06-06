/**
 * Shared types for external ticket-sync integrations.
 * All credential fields that contain secrets are stored encrypted in the DB.
 */

export type IntegrationProvider = 'jira' | 'asana' | 'linear';

// ── Per-provider config shapes ────────────────────────────────────────────────

export interface JiraConfig {
  /** e.g. "https://acme.atlassian.net" */
  baseUrl: string;
  /** Atlassian account email */
  email: string;
  /** API token (encrypted at rest) */
  apiToken: string;
  /** Jira project key, e.g. "ENLIGHT" or "IT" */
  projectKey: string;
  /** Issue type to create, e.g. "Task", "Story", "Service Request" */
  issueType: string;
  /**
   * Maps Enlight statuses → Jira transition names.
   * e.g. { in_progress: "In Progress", resolved: "Done", closed: "Done" }
   */
  statusMap: Record<string, string>;
}

export interface AsanaConfig {
  /** Personal Access Token or OAuth Bearer (encrypted at rest) */
  accessToken: string;
  /** Asana workspace GID */
  workspaceGid: string;
  /** Asana project GID to create tasks in */
  projectGid: string;
  /**
   * Maps Enlight statuses → Asana section GIDs (optional).
   * Without this, resolved → completed=true, others → completed=false.
   */
  statusSectionMap: Record<string, string>;
}

export interface LinearConfig {
  /** Linear API key (encrypted at rest) */
  apiKey: string;
  /** Linear team ID */
  teamId: string;
  /**
   * Maps Enlight statuses → Linear state names.
   * e.g. { open: "Todo", in_progress: "In Progress", resolved: "Done" }
   */
  statusMap: Record<string, string>;
}

export type IntegrationConfig = JiraConfig | AsanaConfig | LinearConfig;

// ── Normalised ticket for cross-provider operations ───────────────────────────

export interface ExternalTicket {
  id: string;
  url: string;
  title: string;
  description: string;
  status: string;   // raw external status name
  priority?: string;
}

export interface SyncResult {
  externalId: string;
  externalUrl: string;
  error?: string;
}
