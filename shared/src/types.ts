// ── Enums ────────────────────────────────────────────────────────────────────

// Built-in role tiers. Custom roles map back to one of these via `baseTier`, so
// `GlobalRole`/`ProjectRole` remain the denormalized cosmetic/back-compat value.
export type GlobalRole = 'super_admin' | 'admin' | 'agent' | 'viewer' | 'customer';
export type ProjectRole = 'admin' | 'agent' | 'viewer' | 'customer';

/** A role (built-in or custom) with a granular permission set. See shared/permissions.ts. */
export interface Role {
  id: string;
  orgId: string;
  scope: 'global' | 'project';
  /** Set only for a project's custom roles; null for global roles and shared built-in project roles. */
  projectId: string | null;
  /** Slug, unique within (org, scope, project). Built-ins use the tier name (e.g. "admin"). */
  key: string;
  name: string;
  description: string | null;
  color: string | null;
  /** The built-in tier this role maps back to (cosmetics + back-compat). */
  baseTier: string;
  /** Granular permission keys this role grants. */
  permissions: string[];
  /** True for the seeded built-in roles. */
  isBuiltin: boolean;
  /** Protected roles (super_admin) always have all permissions and cannot be deleted/stripped. */
  protected: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export type RequestStatus =
  | 'open'
  | 'in_progress'
  | 'pending_user'
  | 'resolved'
  | 'closed';

export type RequestPriority = 'critical' | 'high' | 'medium' | 'low';

export type KnowledgeSourceType = 'confluence' | 'gdrive' | 'notion' | 'file';
export type KnowledgeFileType = 'pdf' | 'txt' | 'rtf' | 'docx';
export type KnowledgeSourceStatus = 'active' | 'syncing' | 'error' | 'pending';

/** Selectable Anthropic (Claude) models for the agent. */
export type ClaudeModel =
  | 'claude-opus-4-5'
  | 'claude-sonnet-4-5'
  | 'claude-haiku-4-5';

/** Selectable OpenAI (GPT) models for the agent. */
export type OpenAIModel = 'gpt-4o' | 'gpt-4o-mini' | 'gpt-4.1' | 'gpt-4.1-mini';

/** Any agent model — the per-project model can belong to either platform. */
export type AIModel = ClaudeModel | OpenAIModel;

/** LLM platform powering the AI agent. */
export type AIProvider = 'anthropic' | 'openai';

export type MCPPermissionLevel = 'read' | 'read_write';

export type SLAAlertChannel = 'slack_dm' | 'slack_channel' | 'email';

// ── Core entities ─────────────────────────────────────────────────────────────

export interface Organization {
  id: string;
  name: string;
  samlConfig: SamlConfig | null;
  scimTokenHash: string | null;
  emailSenderConfig: EmailSenderConfig | null;
  settings: OrganizationSettings;
  createdAt: Date;
  updatedAt: Date;
}

export interface SamlConfig {
  idpMetadataUrl?: string;
  idpMetadataXml?: string;
  nameIdAttribute: string;
  emailAttribute: string;
  firstNameAttribute: string;
  lastNameAttribute: string;
  groupsAttribute: string;
  // Optional profile attribute mappings — IdP attribute names for each profile field.
  departmentAttribute?: string;
  jobTitleAttribute?: string;
  managerAttribute?: string;
  cityAttribute?: string;
  stateAttribute?: string;
  countryAttribute?: string;
}

export interface EmailSenderConfig {
  senderDomain: string;
  senderName: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpUser?: string;
  smtpSecretRef?: string;
  providerApiKeySecretRef?: string;
  provider?: 'smtp' | 'sendgrid' | 'mailgun';
}

export type EmbeddingProvider = 'voyage' | 'openai';

export interface OrganizationSettings {
  /** Claude model used for the offboarding audit summary (Anthropic-only feature). */
  defaultModel?: ClaudeModel;
  dataRetentionDays?: number | null;
  brandName?: string;
  brandPrimaryColor?: string;
  brandLogoUrl?: string;
  // AI platform — which LLM provider powers the agent (default: anthropic).
  // The model itself is chosen per-project (project.aiModel).
  aiProvider?: AIProvider;
  // AI API keys — stored in org settings, override environment variables
  anthropicApiKey?: string;
  voyageApiKey?: string;
  openAiApiKey?: string;
  embeddingProvider?: EmbeddingProvider;
  // Slack credentials — stored per-org, override SLACK_* env vars
  slackBotToken?: string;
  slackSigningSecret?: string;
  slackAppToken?: string;
  // Auto-provisioning: users DMing the bot from these email domains get auto-created
  approvedDomains?: string[];
  autoProvisionRole?: GlobalRole;
  // Cloud provider credentials (Google Cloud, AWS, DigitalOcean).
  gcp?: GcpConfig;
  aws?: AwsConfig;
  digitalocean?: DigitalOceanConfig;
  /** Which provider backs object storage (attachments). */
  storageProvider?: StorageProvider;
  // Google Workspace offboarding automation
  offboarding?: OffboardingConfig;
  // Directory integrations
  rippling?: RipplingSettings;
  jumpcloud?: JumpCloudSettings;
  okta?: OktaSettings;
  // Update source configuration
  updateRepoUrl?: string;
  updateProvider?: 'github' | 'gitlab' | 'bitbucket';
  updateBranch?: string;
}

/** Object-storage backend for attachments. */
export type StorageProvider = 'none' | 'gcs' | 's3' | 'spaces';

// ── Rippling IT ───────────────────────────────────────────────────────────────

export interface RipplingSettings {
  apiToken?: string;
  apiVersion?: string;
  syncEnabled?: boolean;
  offboardingEnabled?: boolean;
  deviceUnenrollEnabled?: boolean;
  lastSyncAt?: string;
}

export interface RipplingWorker {
  id: string;
  employeeNumber?: string;
  workEmail: string;
  personalEmail?: string;
  name: { firstName: string; lastName: string };
  department?: string;
  title?: string;
  startDate?: string;
  terminationDate?: string;
  employmentStatus: 'ACTIVE' | 'INACTIVE' | 'TERMINATED';
  managerId?: string;
}

export interface RipplingDevice {
  id: string;
  name: string;
  serial?: string;
  platform: string;
  enrollmentStatus: string;
}

export interface RipplingWorkerPage {
  data: RipplingWorker[];
  nextCursor?: string;
}

// ── JumpCloud ─────────────────────────────────────────────────────────────────

export type JumpCloudAuthMode = 'apiKey' | 'serviceAccount';

export interface JumpCloudSettings {
  authMode?: JumpCloudAuthMode;
  apiKey?: string;
  clientId?: string;
  clientSecret?: string;
  /** Cached OAuth token — encrypted at rest. */
  cachedAccessToken?: string;
  tokenExpiresAt?: string;
  syncEnabled?: boolean;
  offboardingEnabled?: boolean;
  systemUnbindEnabled?: boolean;
  lastSyncAt?: string;
}

export interface JumpCloudUser {
  id: string;
  username: string;
  email: string;
  firstname?: string;
  lastname?: string;
  department?: string;
  jobTitle?: string;
  suspended: boolean;
  activated: boolean;
  created?: string;
}

export interface JumpCloudSystem {
  id: string;
  displayName?: string;
  hostname?: string;
  os?: string;
  active: boolean;
}

export interface JumpCloudUserPage {
  results: JumpCloudUser[];
  totalCount: number;
  skip: number;
  limit: number;
}

// ── Okta ──────────────────────────────────────────────────────────────────────

export type OktaAuthMode = 'ssws' | 'oauth';

export type OktaUserStatus =
  | 'STAGED'
  | 'PROVISIONED'
  | 'ACTIVE'
  | 'RECOVERY'
  | 'PASSWORD_EXPIRED'
  | 'LOCKED_OUT'
  | 'SUSPENDED'
  | 'DEPROVISIONED';

export interface OktaSettings {
  domain?: string;
  authMode?: OktaAuthMode;
  apiToken?: string;
  clientId?: string;
  privateKeyJwk?: string;
  /** Cached OAuth token — encrypted at rest. */
  cachedAccessToken?: string;
  tokenExpiresAt?: string;
  syncEnabled?: boolean;
  offboardingEnabled?: boolean;
  revokeSessionsEnabled?: boolean;
  removeGroupsEnabled?: boolean;
  lastSyncAt?: string;
}

export interface OktaUser {
  id: string;
  status: OktaUserStatus;
  created?: string;
  activated?: string;
  lastLogin?: string;
  profile: {
    login: string;
    email: string;
    firstName?: string;
    lastName?: string;
    displayName?: string;
    department?: string;
    title?: string;
    mobilePhone?: string;
  };
}

export interface OktaGroup {
  id: string;
  profile: { name: string; description?: string };
}

export interface OktaUserPage {
  users: OktaUser[];
  nextCursor?: string;
}

/**
 * Shared Google Cloud configuration. A single GCP project and service account
 * back every Google integration in Enlight (Workspace offboarding + GCS storage).
 */
export interface GcpConfig {
  /** GCP project ID that all Google features run under. */
  projectId?: string;
  /** Service-account JSON key (with domain-wide delegation). Encrypted at rest. */
  serviceAccountJson?: string;
  /** GCS bucket for attachments. */
  storageBucket?: string;
}

/** AWS credentials (S3 object storage). */
export interface AwsConfig {
  accessKeyId?: string;
  /** Encrypted at rest. */
  secretAccessKey?: string;
  region?: string;
  bucket?: string;
  /** Optional custom endpoint for S3-compatible stores (MinIO, Wasabi, B2…). */
  endpoint?: string;
}

/** DigitalOcean Spaces credentials (S3-compatible). Endpoint derived from region. */
export interface DigitalOceanConfig {
  accessKeyId?: string;
  /** Encrypted at rest. */
  secretAccessKey?: string;
  /** Spaces region, e.g. nyc3 / sfo3 (endpoint = <region>.digitaloceanspaces.com). */
  region?: string;
  bucket?: string;
}

/** Attachment metadata returned to the web UI. */
export interface Attachment {
  id: string;
  requestId: string;
  uploaderId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  storageProvider: StorageProvider;
  createdAt: Date;
}

/** Per-org configuration for the Google Workspace offboarding workflow. */
export interface OffboardingConfig {
  /** Whether offboarding is allowed (toggled from the Slack settings tab). */
  enabled?: boolean;
  /** Super-admin email the service account impersonates (domain-wide delegation). */
  googleAdminEmail?: string;
  googleDomain?: string;
  /** OU departing accounts are moved to. Default "/Departed Employees". */
  departedOuPath?: string;
  /** Optional archive OU; when set, an Archive option appears in the modal. */
  archiveOuPath?: string;
  /** Slack channel (id or #name) where audit summaries are posted. */
  auditChannel?: string;
  /** Project a tracking ticket is opened in for each offboarding (set in the Slack tab). */
  trackingProjectId?: string;
  /** Force mock mode even when credentials are present. */
  mockMode?: boolean;
  /** Microsoft 365 (Microsoft Graph) offboarding config. */
  microsoft?: Microsoft365Config;
}

/** Microsoft 365 offboarding config (Microsoft Graph, client-credentials flow). */
export interface Microsoft365Config {
  enabled?: boolean;
  tenantId?: string;
  clientId?: string;
  /** App registration client secret. Encrypted at rest. */
  clientSecret?: string;
  /** Transfer the departing user's OneDrive to their delegate/manager. */
  transferToManager?: boolean;
  /** Force mock mode even when credentials are present. */
  mockMode?: boolean;
}

// ── Offboarding checklists ──────────────────────────────────────────────────

export type ChecklistStepType = 'manual' | 'automated';
export type ChecklistAuthType = 'none' | 'bearer' | 'api_key' | 'basic';

/** Template variables substituted into an automated step's URL/headers/body. */
export const OFFBOARDING_TEMPLATE_VARS = [
  '{{targetEmail}}',
  '{{targetUserName}}',
  '{{targetFirstName}}',
  '{{targetLastName}}',
  '{{delegateEmail}}',
  '{{date}}',
] as const;

export interface OffboardingChecklist {
  id: string;
  orgId: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
  /** Present when fetched with steps. */
  steps?: ChecklistStep[];
}

export interface ChecklistStep {
  id: string;
  checklistId: string;
  orgId: string;
  position: number;
  type: ChecklistStepType;
  name: string;
  description: string | null;
  enabled: boolean;
  // automated-only
  method: string | null;
  url: string | null;
  headers: Record<string, string>;
  bodyTemplate: string | null;
  authType: ChecklistAuthType;
  authHeaderName: string | null;
  /** True when a credential is stored (the secret itself is never returned). */
  credentialSet: boolean;
  expectedStatusMin: number;
  expectedStatusMax: number;
  schemaText: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Editable shape for creating/updating a step (credential sent only when changed). */
export interface ChecklistStepInput {
  type: ChecklistStepType;
  name: string;
  description?: string | null;
  enabled?: boolean;
  position?: number;
  method?: string | null;
  url?: string | null;
  headers?: Record<string, string>;
  bodyTemplate?: string | null;
  authType?: ChecklistAuthType;
  authHeaderName?: string | null;
  /** New credential value; omit/empty to keep the existing one. */
  credential?: string | null;
  expectedStatusMin?: number;
  expectedStatusMax?: number;
  schemaText?: string | null;
}

/** AI-proposed request template returned by the offboarding checklist AI builder. */
export interface AiBuiltRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  bodyTemplate: string;
  authType: ChecklistAuthType;
  authHeaderName?: string;
  notes?: string;
}

export type OffboardingStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'completed_with_errors'
  | 'failed';

/** Outcome of a single Google Workspace operation during offboarding. */
export interface OffboardingActionResult {
  action: string;
  success: boolean;
  details: string;
  error?: string;
}

export interface OffboardingEvent {
  id: string;
  orgId: string;
  targetEmail: string;
  targetUserId: string | null;
  delegateEmail: string | null;
  archive: boolean;
  status: OffboardingStatus;
  actions: OffboardingActionResult[];
  aiSummary: string | null;
  error: string | null;
  triggeredById: string | null;
  triggeredVia: 'slack' | 'web' | 'agent';
  requestId: string | null;
  slackMessageTs: string | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}

/** Live Google Workspace profile card for the offboarding UI. */
export interface OffboardingProfileLookup {
  found: boolean;
  email: string;
  name?: string;
  employeeId?: string;
  jobTitle?: string;
  department?: string;
  managerEmail?: string;
  suspended?: boolean;
  error?: string;
}

export interface OrgDetails {
  id: string;
  name: string;
  settings: OrganizationSettings;
  emailSenderConfig: EmailSenderConfig | null;
  samlConfig: SamlConfig | null;
  createdAt: Date;
}

/** Result of validating an external IdP SAML metadata URL. */
export interface SamlMetadataValidation {
  valid: boolean;
  /** The IdP's entityID from the metadata, if found. */
  entityId?: string;
  /** The IdP Single Sign-On service endpoint(s). */
  ssoUrls?: string[];
  /** SAML bindings advertised for SSO (e.g. HTTP-Redirect, HTTP-POST). */
  bindings?: string[];
  /** Whether a signing X.509 certificate is present in the metadata. */
  hasCertificate?: boolean;
  /** HTTP status returned when fetching the URL. */
  httpStatus?: number;
  /** Human-readable error when validation fails. */
  error?: string;
}

/** Service Provider connection details for configuring an external IdP / SCIM client. */
export interface SsoConnectionInfo {
  /** SP Entity ID (a.k.a. Audience URI) to register in the IdP. */
  entityId: string;
  /** Assertion Consumer Service (ACS) / SAML reply URL. */
  acsUrl: string;
  /** Base URL for the SCIM v2 provisioning client. */
  scimBaseUrl: string;
  /** Whether a SCIM bearer token has been generated. */
  scimTokenSet: boolean;
}

export interface MCPApiKeyPublic {
  id: string;
  name: string;
  permissionLevel: MCPPermissionLevel;
  projectIds: string[];
  createdAt: Date;
  lastUsedAt: Date | null;
}

export interface MCPApiKeyCreated extends MCPApiKeyPublic {
  key: string; // raw key — shown only once
}

export interface Project {
  id: string;
  orgId: string;
  name: string;
  slug: string;
  key: string;
  lastTicketNumber: number;
  description: string | null;
  icon: string | null;
  aiModel: AIModel;
  aiInstructions: string | null;
  aiAutonomousMode: boolean;
  aiEscalationThreshold: number;
  slaPolicies: SlaPolicy[];
  slaAlertConfig: SlaAlertConfig;
  categories: ProjectCategory[];
  customFields: CustomFieldDef[];
  defaultAssigneeId: string | null;
  escalationPath: string | null;
  slackQuickActions: SlackQuickAction[];
  /** Weekly support/business hours. null = 24/7 (no defined hours). */
  supportHours: SupportHours | null;
  accessType: 'open' | 'restricted';
  /** Groups assigned to this project. Legacy format is string[]; new format is ProjectGroupAssignment[]. */
  allowedSlackUserGroups: ProjectGroupAssignment[];
  status: 'active' | 'archived';
  /** Public request portal — anyone with the link can submit tickets. */
  portalEnabled: boolean;
  portalToken: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SlaPolicy {
  priority: RequestPriority;
  responseTimeMinutes: number;
  resolutionTimeMinutes: number;
}

export interface SlaAlertConfig {
  channels: SLAAlertChannel[];
  slackChannelId?: string;
}

// ── Scheduling: support hours + on-call rotations ──────────────────────────────

export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

export interface SupportHoursDay {
  day: Weekday;
  enabled: boolean;
  /** Local 'HH:MM' in the support-hours timezone. */
  from: string;
  to: string;
}

export interface SupportHours {
  timezone: string;
  days: SupportHoursDay[];
}

export interface OnCallSchedule {
  id: string;
  projectId: string;
  name: string;
  timezone: string;
  /** Shift length in days (1 = daily, 7 = weekly). */
  rotationDays: number;
  /** Local 'HH:MM' handoff time in `timezone`. */
  handoffTime: string;
  /** Anchor civil date 'YYYY-MM-DD' — when the first participant's shift begins. */
  startDate: string;
  /** Ordered list of user IDs that rotate. */
  participants: string[];
  createdAt: string;
  updatedAt: string;
  /** Computed by the API: who is on call right now (null if no participants / not started). */
  currentOnCallUserId?: string | null;
  /** Computed: local datetime string ('YYYY-MM-DD HH:MM') when the current shift ends. */
  currentShiftEndsAt?: string | null;
}

export interface ProjectCategory {
  id: string;
  name: string;
  subcategories: string[];
}

export interface CustomFieldDef {
  id: string;
  label: string;
  type: 'text' | 'number' | 'select' | 'dropdown' | 'boolean' | 'date';
  options?: string[];
  required: boolean;
}

export interface User {
  id: string;
  orgId: string;
  email: string;
  name: string;
  externalId: string | null;
  samlNameId: string | null;
  globalRole: GlobalRole;
  slackUserId: string | null;
  // Profile fields — editable, and synced from SCIM / SAML when configured.
  department: string | null;
  jobTitle: string | null;
  managerId: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Per-user email notification opt-ins. true (or missing key) = opted in. */
export interface EmailPreferences {
  ticketCreated?: boolean;   // confirmation email when they open a ticket
  agentReplied?: boolean;    // email when an agent replies to their ticket
  ticketResolved?: boolean;  // email when their ticket is resolved
  assigned?: boolean;        // email when a ticket is assigned to them
  requesterReplied?: boolean; // email (to assignee) when requester replies
}

/** A Slack user group assigned to a project with a specific role. */
export interface ProjectGroupAssignment {
  id: string;     // Slack usergroup ID
  role: ProjectRole;
}

export interface ProjectMember {
  projectId: string;
  userId: string;
  role: ProjectRole;
  /** Granular role (RBAC); null for legacy rows. `role` is the baseTier mirror. */
  roleId?: string | null;
  createdAt: Date;
}

export interface ProjectMemberDetail extends ProjectMember {
  user: Pick<User, 'id' | 'name' | 'email' | 'globalRole'>;
}

export interface Request {
  id: string;
  projectId: string;
  ticketNumber: number;
  title: string;
  description: string;
  status: RequestStatus;
  priority: RequestPriority;
  category: string | null;
  subcategory: string | null;
  requesterId: string;
  assigneeId: string | null;
  customFields: Record<string, unknown>;
  slackThreadTs: string | null;
  slackUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
  resolvedAt: Date | null;
}

export interface Comment {
  id: string;
  requestId: string;
  authorId: string;
  body: string;
  isInternal: boolean;
  aiGenerated: boolean;
  createdAt: Date;
}

export interface Attachment {
  id: string;
  requestId: string;
  uploaderId: string;
  gcsObjectKey: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  createdAt: Date;
}

export interface AIAction {
  id: string;
  requestId: string;
  actionType: string;
  model: AIModel;
  inputTokens: number;
  outputTokens: number;
  confidence: number | null;
  rationale: string | null;
  createdAt: Date;
}

// ── Slack quick actions ───────────────────────────────────────────────────────

export type QuickActionFieldType = 'text' | 'textarea' | 'select' | 'date';

export interface SlackQuickActionField {
  id: string;
  label: string;
  type: QuickActionFieldType;
  options?: string[];   // only used when type === 'select'
  required: boolean;
  placeholder?: string;
}

export interface SlackQuickAction {
  id: string;
  label: string;           // button label, e.g. "New Hire Request"
  emoji: string;           // e.g. "👋"
  description: string;     // shown as modal title / subtitle
  priority: RequestPriority;
  fields: SlackQuickActionField[];
  /** Which project roles can see this action. Empty/undefined = all roles. */
  visibleToRoles?: ProjectRole[];
}

// ── Knowledge base ────────────────────────────────────────────────────────────

export interface KnowledgeSource {
  id: string;
  projectId: string;
  type: KnowledgeSourceType;
  fileType: KnowledgeFileType | null;
  config: Record<string, unknown>;
  chunkSize: number;
  chunkOverlap: number;
  minChunkSize: number;
  oauthSecretRef: string | null;
  lastSyncedAt: Date | null;
  status: KnowledgeSourceStatus;
  documentCount: number;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface KnowledgeChunk {
  id: string;
  sourceId: string;
  title: string;
  body: string;
  embedding: number[];
  sourceUrl: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

export interface AuditLog {
  id: string;
  orgId: string;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  diff: Record<string, unknown> | null;
  createdAt: Date;
}

export interface MCPApiKey {
  id: string;
  orgId: string;
  keyHash: string;
  name: string;
  permissionLevel: MCPPermissionLevel;
  projectIds: string[];
  createdAt: Date;
  lastUsedAt: Date | null;
}

export interface SlackStatus {
  running: boolean;
  teamName?: string;
  botName?: string;
}

// ── API request/response shapes ───────────────────────────────────────────────

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ApiError {
  error: string;
  message: string;
  statusCode: number;
}

// ── Dashboard layouts ─────────────────────────────────────────────────────────

export type DashboardWidgetType =
  | 'stat_open'
  | 'stat_in_progress'
  | 'stat_resolved_today'
  | 'stat_sla_breaches'
  | 'recent_requests'
  | 'project_summary'
  | 'custom_query';

export interface DashboardWidgetFilters {
  /** Restrict to these project IDs. Empty / absent = all projects. */
  projectIds?: string[];
  /** For recent_requests: filter by status. */
  statuses?: RequestStatus[];
  /** For recent_requests: filter by priority. */
  priorities?: RequestPriority[];
  /** For recent_requests: max rows to show (default 10). */
  limit?: number;
}

export interface DashboardWidget {
  id: string;
  type: DashboardWidgetType;
  /** Custom title override. If absent, the default label for the type is used. */
  title?: string;
  /** Column span in a 4-column grid (default 1 for stats, 3 for recent_requests, 1 for project_summary). */
  colspan?: 1 | 2 | 3 | 4;
  /** Optional filters applied when rendering this widget. */
  filters?: DashboardWidgetFilters;
  /** SQL query string — only used when type === 'custom_query'. */
  query?: string;
  /** Chart visualization config — only used when type === 'custom_query'. If absent, data is shown as a table. */
  chartConfig?: DashboardChartConfig;
}

/** Result returned by POST /dashboard/query. */
export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
  durationMs: number;
}

// ── Dashboard chart config ─────────────────────────────────────────────────────

export type ChartType = 'bar' | 'line' | 'area' | 'pie';

export interface DashboardChartConfig {
  chartType: ChartType;
  /** Column used for x-axis labels (bar/line/area) or slice labels (pie). */
  xKey: string;
  /** Columns to use as numeric y-values. Multiple = multi-series for bar/line/area. */
  yKeys: string[];
  /** Bar charts only: render bars horizontally. */
  horizontal?: boolean;
}

export interface DashboardLayoutConfig {
  widgets: DashboardWidget[];
}

export interface DashboardLayout {
  id: string;
  userId: string;
  orgId: string;
  name: string;
  isDefault: boolean;
  config: DashboardLayoutConfig;
  createdAt: string;
  updatedAt: string;
}

// ── Analytics ───────────────────────────────────────────────────────────────

export type AnalyticsReportType = 'builtin' | 'custom';

/** A saved analytics report — either a built-in (keyed by name) or a custom SQL report. */
export interface AnalyticsReport {
  id: string;
  orgId: string;
  createdById: string;
  name: string;
  description: string | null;
  type: AnalyticsReportType;
  /** SQL query — only present for custom reports. */
  query: string | null;
  /** Optional chart config. If null, the report renders as a table only. */
  chartConfig: DashboardChartConfig | null;
  shared: boolean;
  createdAt: string;
  updatedAt: string;
}

// ── Automation / workflow ─────────────────────────────────────────────────────

export type AutomationTriggerType =
  | 'request_created'
  | 'request_updated'
  | 'comment_added'
  | 'time_based';

/** Time-based trigger metric — elapsed hours since a timestamp on the request. */
export type AutomationTimeMetric = 'hours_since_created' | 'hours_since_updated';

export interface AutomationTrigger {
  type: AutomationTriggerType;
  /** time_based only: which elapsed-time metric to compare. */
  metric?: AutomationTimeMetric;
  /** time_based only: threshold in hours (fires when metric > hours). */
  hours?: number;
  /**
   * IANA timezone (e.g. 'America/New_York') used for all time-of-day evaluation:
   * the business-hours window below, and any comment_hour / comment_weekday
   * conditions on the rule. Defaults to UTC when unset.
   */
  timezone?: string;
  /** time_based business-hours window — only fire when the local hour is in
   *  [activeFromHour, activeToHour). Both must be set for the window to apply.
   *  Supports overnight windows (from > to, e.g. 22→6). */
  activeFromHour?: number;
  activeToHour?: number;
  /** time_based: weekdays (mon…sun) the rule may fire on. Empty/absent = any day. */
  activeDays?: string[];
}

export type AutomationConditionField =
  | 'status' | 'priority' | 'category' | 'subcategory'
  | 'assigneeId' | 'title' | 'description'
  // Comment-scoped fields — only meaningful for the `comment_added` trigger.
  | 'comment_body'        // the comment text (content)
  | 'comment_is_internal' // 'true' | 'false'
  | 'comment_hour'        // hour of day the comment was posted, 0–23 (UTC)
  | 'comment_weekday';    // 'mon' | 'tue' | … | 'sun'

export type AutomationConditionOp =
  | 'eq' | 'neq' | 'contains' | 'in' | 'is_empty' | 'is_not_empty'
  // Numeric comparisons — used by comment_hour (e.g. posted after 17:00).
  | 'gt' | 'lt' | 'gte' | 'lte';

export interface AutomationCondition {
  field: AutomationConditionField;
  op: AutomationConditionOp;
  /** string for eq/neq/contains/gt/lt/…; string[] for `in`; ignored for is_empty/is_not_empty. */
  value?: string | string[];
}

export type AutomationActionType =
  | 'set_fields' | 'add_comment' | 'notify_slack' | 'trigger_ai' | 'http_request';

export interface AutomationActionSetFields {
  type: 'set_fields';
  status?: RequestStatus;
  priority?: RequestPriority;
  /** User id to assign, or "unassign" to clear. */
  assigneeId?: string;
  category?: string;
}

export interface AutomationActionAddComment {
  type: 'add_comment';
  /** Supports {{ticket_number}}, {{title}}, {{status}}, {{priority}}, {{url}} templating. */
  body: string;
  isInternal?: boolean;
}

export interface AutomationActionNotifySlack {
  type: 'notify_slack';
  /** Slack channel ID (Cxxx) or user ID (Uxxx) to DM. */
  target: string;
  message: string;
}

export interface AutomationActionTriggerAi {
  type: 'trigger_ai';
}

export interface AutomationActionHttpRequest {
  type: 'http_request';
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  /** Templated request body (sent for non-GET). */
  body?: string;
}

export type AutomationAction =
  | AutomationActionSetFields
  | AutomationActionAddComment
  | AutomationActionNotifySlack
  | AutomationActionTriggerAi
  | AutomationActionHttpRequest;

export interface AutomationRule {
  id: string;
  projectId: string;
  name: string;
  enabled: boolean;
  trigger: AutomationTrigger;
  conditions: AutomationCondition[];
  actions: AutomationAction[];
  lastTriggeredAt: string | null;
  triggerCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface AutomationRun {
  id: string;
  ruleId: string;
  requestId: string;
  status: 'success' | 'error' | 'partial';
  detail: string | null;
  createdAt: string;
}

/** Built-in report definitions shipped with the product. Run server-side via known SQL. */
export interface BuiltinReport {
  key: string;
  name: string;
  description: string;
  chartConfig: DashboardChartConfig | null;
}

/** Entities that can be exported to CSV via the analytics export endpoint. */
export type ExportEntity = 'requests' | 'comments' | 'projects' | 'users' | 'ai_actions';

export interface ExportEntityMeta {
  entity: ExportEntity;
  label: string;
  description: string;
}
