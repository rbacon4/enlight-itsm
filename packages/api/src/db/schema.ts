import {
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  jsonb,
  uuid,
  pgEnum,
  index,
  uniqueIndex,
  vector,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

// ── Enums ─────────────────────────────────────────────────────────────────────

export const globalRoleEnum = pgEnum('global_role', [
  'super_admin',
  'admin',
  'agent',
  'viewer',
  'customer',
]);

export const projectRoleEnum = pgEnum('project_role', [
  'admin',
  'agent',
  'viewer',
  'customer',
]);

export const requestStatusEnum = pgEnum('request_status', [
  'open',
  'in_progress',
  'pending_user',
  'resolved',
  'closed',
]);

export const requestPriorityEnum = pgEnum('request_priority', [
  'critical',
  'high',
  'medium',
  'low',
]);

export const slaAlertTypeEnum = pgEnum('sla_alert_type', [
  'response_breached',
  'resolution_breached',
]);

export const knowledgeSourceTypeEnum = pgEnum('knowledge_source_type', [
  'confluence',
  'gdrive',
  'notion',
  'file',
]);

export const knowledgeFileTypeEnum = pgEnum('knowledge_file_type', [
  'pdf',
  'txt',
  'rtf',
  'docx',
]);

export const knowledgeSourceStatusEnum = pgEnum('knowledge_source_status', [
  'active',
  'syncing',
  'error',
  'pending',
]);

export const aiModelEnum = pgEnum('ai_model', [
  'claude-opus-4-5',
  'claude-sonnet-4-5',
  'claude-haiku-4-5',
]);

export const mcpPermissionLevelEnum = pgEnum('mcp_permission_level', [
  'read',
  'read_write',
]);

export const projectStatusEnum = pgEnum('project_status', ['active', 'archived']);

export const projectAccessEnum = pgEnum('project_access', ['open', 'restricted']);

// ── Tables ────────────────────────────────────────────────────────────────────

export const organizations = pgTable('organizations', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  samlConfig: jsonb('saml_config'),
  scimTokenHash: text('scim_token_hash'),
  emailSenderConfig: jsonb('email_sender_config'),
  settings: jsonb('settings').notNull().default('{}'),
  /** Signed license key (Ed25519-over-JSON). Verified on boot. */
  licenseKey: text('license_key'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const roles = pgTable(
  'roles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    // 'global' | 'project'
    scope: text('scope').notNull(),
    // Set only for a project's custom roles; null for global + shared built-in project roles.
    projectId: uuid('project_id').references((): AnyPgColumn => projects.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    color: text('color'),
    // The built-in tier this role maps back to (cosmetics + back-compat mirror).
    baseTier: text('base_tier').notNull(),
    permissions: jsonb('permissions').notNull().default('[]'),
    isBuiltin: boolean('is_builtin').notNull().default(false),
    protected: boolean('protected').notNull().default(false),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('roles_org_scope_idx').on(t.orgId, t.scope),
    index('roles_project_idx').on(t.projectId),
  ],
);

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    key: text('key').notNull().default(''),
    description: text('description'),
    icon: text('icon'),
    aiModel: aiModelEnum('ai_model').notNull().default('claude-sonnet-4-5'),
    aiInstructions: text('ai_instructions'),
    aiAutonomousMode: boolean('ai_autonomous_mode').notNull().default(false),
    aiEscalationThreshold: integer('ai_escalation_threshold').notNull().default(80),
    slaPolicies: jsonb('sla_policies').notNull().default('[]'),
    slaAlertConfig: jsonb('sla_alert_config').notNull().default('{"channels":[]}'),
    categories: jsonb('categories').notNull().default('[]'),
    customFields: jsonb('custom_fields').notNull().default('[]'),
    defaultAssigneeId: uuid('default_assignee_id'),
    escalationPath: text('escalation_path'),
    slackQuickActions: jsonb('slack_quick_actions').notNull().default('[]'),
    // Weekly support/business hours: { timezone, days: [{day, enabled, from, to}] }. null = 24/7.
    supportHours: jsonb('support_hours'),
    accessType: projectAccessEnum('access_type').notNull().default('open'),
    allowedSlackUserGroups: jsonb('allowed_slack_user_groups').notNull().default('[]'),
    status: projectStatusEnum('status').notNull().default('active'),
    lastTicketNumber: integer('last_ticket_number').notNull().default(0),
    /** Public request portal. When enabled, anyone with the URL can submit a ticket. */
    portalEnabled: boolean('portal_enabled').notNull().default(false),
    /** Random 32-byte hex token that forms the public portal URL. */
    portalToken: text('portal_token'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('projects_org_slug_idx').on(t.orgId, t.slug),
    uniqueIndex('projects_org_key_idx').on(t.orgId, t.key),
  ],
);

// ── Request templates ─────────────────────────────────────────────────────────

export const requestTemplates = pgTable(
  'request_templates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    /** Pre-filled ticket fields. */
    title: text('title').notNull().default(''),
    body: text('body').notNull().default(''),
    priority: requestPriorityEnum('priority').notNull().default('medium'),
    category: text('category'),
    subcategory: text('subcategory'),
    customFields: jsonb('custom_fields').notNull().default('{}'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('request_templates_project_idx').on(t.projectId),
  ],
);

// ── CSAT surveys ──────────────────────────────────────────────────────────────

export const csatSurveys = pgTable(
  'csat_surveys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => requests.id, { onDelete: 'cascade' }),
    /** Random token used in the public response URL. */
    token: text('token').notNull(),
    sentAt: timestamp('sent_at').notNull().defaultNow(),
    respondedAt: timestamp('responded_at'),
    /** 1–5 star rating. */
    rating: integer('rating'),
    comment: text('comment'),
  },
  (t) => [
    uniqueIndex('csat_surveys_request_idx').on(t.requestId),
    uniqueIndex('csat_surveys_token_idx').on(t.token),
  ],
);

// ── Webhook deliveries ────────────────────────────────────────────────────────

export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    webhookId: uuid('webhook_id')
      .notNull()
      .references(() => webhooks.id, { onDelete: 'cascade' }),
    event: text('event').notNull(),
    statusCode: integer('status_code'),
    /** Truncated response body (first 1 KB). */
    responseBody: text('response_body'),
    durationMs: integer('duration_ms'),
    success: boolean('success').notNull().default(false),
    attemptNumber: integer('attempt_number').notNull().default(1),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('webhook_deliveries_webhook_idx').on(t.webhookId),
    index('webhook_deliveries_created_at_idx').on(t.createdAt),
  ],
);

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    name: text('name').notNull(),
    passwordHash: text('password_hash'),
    externalId: text('external_id'),
    samlNameId: text('saml_name_id'),
    /** TOTP (authenticator app) 2FA. Secret stored encrypted via secretCrypto. */
    totpSecret: text('totp_secret'),
    totpEnabled: boolean('totp_enabled').notNull().default(false),
    /** Per-user email notification opt-ins. Defaults to all enabled. */
    emailPreferences: jsonb('email_preferences').notNull().default('{}'),
    globalRole: globalRoleEnum('global_role').notNull().default('customer'),
    // Granular role (RBAC). globalRole stays as the denormalized baseTier mirror.
    roleId: uuid('role_id').references((): AnyPgColumn => roles.id, { onDelete: 'set null' }),
    slackUserId: text('slack_user_id'),
    // ── Profile fields (populated manually or synced from SCIM / SAML) ──
    department: text('department'),
    jobTitle: text('job_title'),
    managerId: uuid('manager_id').references((): AnyPgColumn => users.id, { onDelete: 'set null' }),
    city: text('city'),
    state: text('state'),
    country: text('country'),
    // Active flag — set false to deprovision (e.g. via SCIM). Inactive users cannot log in.
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('users_org_email_idx').on(t.orgId, t.email),
    index('users_slack_user_id_idx').on(t.slackUserId),
  ],
);

export const projectMembers = pgTable(
  'project_members',
  {
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: projectRoleEnum('role').notNull(),
    // Granular role (RBAC). `role` stays as the denormalized baseTier mirror.
    roleId: uuid('role_id').references((): AnyPgColumn => roles.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('project_members_pk').on(t.projectId, t.userId),
  ],
);

export const requests = pgTable(
  'requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    ticketNumber: integer('ticket_number').notNull().default(0),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    status: requestStatusEnum('status').notNull().default('open'),
    priority: requestPriorityEnum('priority').notNull().default('medium'),
    category: text('category'),
    subcategory: text('subcategory'),
    requesterId: uuid('requester_id')
      .notNull()
      .references(() => users.id),
    assigneeId: uuid('assignee_id').references(() => users.id),
    customFields: jsonb('custom_fields').notNull().default('{}'),
    slackThreadTs: text('slack_thread_ts'),
    slackUserId: text('slack_user_id'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at'),
  },
  (t) => [
    uniqueIndex('requests_project_ticket_number_idx').on(t.projectId, t.ticketNumber),
    index('requests_project_status_idx').on(t.projectId, t.status),
    index('requests_assignee_idx').on(t.assigneeId),
    index('requests_requester_idx').on(t.requesterId),
    index('requests_slack_thread_idx').on(t.slackThreadTs),
  ],
);

export const comments = pgTable('comments', {
  id: uuid('id').primaryKey().defaultRandom(),
  requestId: uuid('request_id')
    .notNull()
    .references(() => requests.id, { onDelete: 'cascade' }),
  authorId: uuid('author_id')
    .notNull()
    .references(() => users.id),
  body: text('body').notNull(),
  isInternal: boolean('is_internal').notNull().default(false),
  aiGenerated: boolean('ai_generated').notNull().default(false),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const attachments = pgTable('attachments', {
  id: uuid('id').primaryKey().defaultRandom(),
  requestId: uuid('request_id')
    .notNull()
    .references(() => requests.id, { onDelete: 'cascade' }),
  uploaderId: uuid('uploader_id')
    .notNull()
    .references(() => users.id),
  // Provider-agnostic object key (named gcs_* for legacy reasons).
  gcsObjectKey: text('gcs_object_key').notNull(),
  // Which storage backend holds this object (gcs | s3 | spaces).
  storageProvider: text('storage_provider').notNull().default('gcs'),
  filename: text('filename').notNull(),
  contentType: text('content_type').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const aiActions = pgTable('ai_actions', {
  id: uuid('id').primaryKey().defaultRandom(),
  requestId: uuid('request_id')
    .notNull()
    .references(() => requests.id, { onDelete: 'cascade' }),
  actionType: text('action_type').notNull(),
  model: aiModelEnum('model').notNull(),
  inputTokens: integer('input_tokens').notNull(),
  outputTokens: integer('output_tokens').notNull(),
  confidence: integer('confidence'),
  rationale: text('rationale'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const knowledgeSources = pgTable('knowledge_sources', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  type: knowledgeSourceTypeEnum('type').notNull(),
  fileType: knowledgeFileTypeEnum('file_type'),
  config: jsonb('config').notNull().default('{}'),
  chunkSize: integer('chunk_size').notNull().default(512),
  chunkOverlap: integer('chunk_overlap').notNull().default(64),
  minChunkSize: integer('min_chunk_size').notNull().default(64),
  oauthSecretRef: text('oauth_secret_ref'),
  lastSyncedAt: timestamp('last_synced_at'),
  status: knowledgeSourceStatusEnum('status').notNull().default('pending'),
  documentCount: integer('document_count').notNull().default(0),
  errorMessage: text('error_message'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const knowledgeChunks = pgTable(
  'knowledge_chunks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => knowledgeSources.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    body: text('body').notNull(),
    // 1536-dimensional vectors from Anthropic Embeddings API
    embedding: vector('embedding', { dimensions: 1536 }),
    sourceUrl: text('source_url'),
    metadata: jsonb('metadata').notNull().default('{}'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('knowledge_chunks_source_idx').on(t.sourceId),
  ],
);

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    actorId: uuid('actor_id').references(() => users.id),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    diff: jsonb('diff'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('audit_logs_org_idx').on(t.orgId),
    index('audit_logs_entity_idx').on(t.entityType, t.entityId),
    index('audit_logs_created_at_idx').on(t.createdAt),
  ],
);

// ── Outbound webhooks ─────────────────────────────────────────────────────────

/** Org-level outbound webhooks. Each row is a registered endpoint that receives
 *  HTTP POST payloads when subscribed events fire. */
export const webhooks = pgTable(
  'webhooks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    /** Array of event names, e.g. ["request.created","request.resolved"]. Empty = all events. */
    events: text('events').array().notNull().default([]),
    /** HMAC-SHA256 signing secret — sent as X-Enlight-Signature header. */
    secret: text('secret').notNull(),
    active: boolean('active').notNull().default(true),
    description: text('description'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('webhooks_org_idx').on(t.orgId),
  ],
);

// One row per (request, alert_type) — prevents duplicate SLA breach notifications.
export const slaAlerts = pgTable(
  'sla_alerts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => requests.id, { onDelete: 'cascade' }),
    alertType: slaAlertTypeEnum('alert_type').notNull(),
    sentAt: timestamp('sent_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('sla_alerts_request_type_idx').on(t.requestId, t.alertType),
    index('sla_alerts_request_idx').on(t.requestId),
  ],
);

export const offboardingChecklists = pgTable(
  'offboarding_checklists',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    isDefault: boolean('is_default').notNull().default(false),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => [index('offboarding_checklists_org_idx').on(t.orgId)],
);

export const offboardingChecklistSteps = pgTable(
  'offboarding_checklist_steps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    checklistId: uuid('checklist_id')
      .notNull()
      .references(() => offboardingChecklists.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    position: integer('position').notNull().default(0),
    // 'manual' | 'automated'
    type: text('type').notNull().default('manual'),
    name: text('name').notNull(),
    description: text('description'),
    enabled: boolean('enabled').notNull().default(true),
    // ── automated-step fields ──
    method: text('method'),
    url: text('url'),
    headers: jsonb('headers').notNull().default('{}'),
    bodyTemplate: text('body_template'),
    // 'none' | 'bearer' | 'api_key' | 'basic'
    authType: text('auth_type').notNull().default('none'),
    authHeaderName: text('auth_header_name'),
    // Encrypted credential (bearer token / api key value / "user:pass").
    credentialEnc: text('credential_enc'),
    expectedStatusMin: integer('expected_status_min').notNull().default(200),
    expectedStatusMax: integer('expected_status_max').notNull().default(299),
    // Uploaded API schema kept so the AI builder can be re-run.
    schemaText: text('schema_text'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => [index('offboarding_checklist_steps_checklist_idx').on(t.checklistId)],
);

export const offboardingEvents = pgTable(
  'offboarding_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    targetEmail: text('target_email').notNull(),
    targetUserId: uuid('target_user_id').references(() => users.id, { onDelete: 'set null' }),
    delegateEmail: text('delegate_email'),
    archive: boolean('archive').notNull().default(false),
    // pending | running | completed | completed_with_errors | failed
    status: text('status').notNull().default('pending'),
    // Array of { action, success, details, error? }
    actions: jsonb('actions').notNull().default('[]'),
    aiSummary: text('ai_summary'),
    error: text('error'),
    triggeredById: uuid('triggered_by_id').references(() => users.id, { onDelete: 'set null' }),
    // slack | web | agent
    triggeredVia: text('triggered_via').notNull().default('web'),
    requestId: uuid('request_id').references(() => requests.id, { onDelete: 'set null' }),
    slackMessageTs: text('slack_message_ts'),
    // Checklist applied to this offboarding + a snapshot of its manual steps.
    checklistId: uuid('checklist_id').references((): AnyPgColumn => offboardingChecklists.id, { onDelete: 'set null' }),
    manualSteps: jsonb('manual_steps').notNull().default('[]'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
    completedAt: timestamp('completed_at'),
  },
  (t) => [
    index('offboarding_events_org_idx').on(t.orgId),
    index('offboarding_events_created_at_idx').on(t.createdAt),
  ],
);

export const mcpApiKeys = pgTable('mcp_api_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  keyHash: text('key_hash').notNull(),
  name: text('name').notNull(),
  permissionLevel: mcpPermissionLevelEnum('permission_level')
    .notNull()
    .default('read'),
  projectIds: jsonb('project_ids').notNull().default('[]'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  lastUsedAt: timestamp('last_used_at'),
});

export const dashboardLayouts = pgTable(
  'dashboard_layouts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    isDefault: boolean('is_default').notNull().default(false),
    config: jsonb('config').notNull().default('{"widgets":[]}'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('dashboard_layouts_user_idx').on(t.userId),
  ],
);

export const analyticsReports = pgTable(
  'analytics_reports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    createdById: uuid('created_by_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    // 'builtin' reports reference a known key; 'custom' reports carry SQL.
    type: text('type').notNull().default('custom'),
    query: text('query'),
    // Optional chart visualisation config (chartType / xKey / yKeys), null = table only.
    chartConfig: jsonb('chart_config'),
    // Whether this report is visible to the whole org or just its creator.
    shared: boolean('shared').notNull().default(true),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('analytics_reports_org_idx').on(t.orgId),
  ],
);

// Directory groups — synced from an IdP via SCIM. Org-scoped.
export const groups = pgTable(
  'groups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    displayName: text('display_name').notNull(),
    // The IdP's identifier for this group, if provided.
    externalId: text('external_id'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('groups_org_idx').on(t.orgId),
  ],
);

export const groupMembers = pgTable(
  'group_members',
  {
    groupId: uuid('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('group_members_pk').on(t.groupId, t.userId),
    index('group_members_user_idx').on(t.userId),
  ],
);

// Automation / workflow rules — per project.
export const automationRules = pgTable(
  'automation_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    // { type: 'request_created' | 'request_updated' | 'comment_added' | 'time_based', ... }
    trigger: jsonb('trigger').notNull(),
    // Array of { field, op, value } conditions (ANDed).
    conditions: jsonb('conditions').notNull().default('[]'),
    // Array of action objects (see shared AutomationAction).
    actions: jsonb('actions').notNull().default('[]'),
    lastTriggeredAt: timestamp('last_triggered_at'),
    triggerCount: integer('trigger_count').notNull().default(0),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('automation_rules_project_idx').on(t.projectId),
  ],
);

// Execution log — also used to de-duplicate time-based rules (fire once per request).
export const automationRuns = pgTable(
  'automation_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ruleId: uuid('rule_id')
      .notNull()
      .references(() => automationRules.id, { onDelete: 'cascade' }),
    requestId: uuid('request_id')
      .notNull()
      .references(() => requests.id, { onDelete: 'cascade' }),
    status: text('status').notNull(), // 'success' | 'error' | 'partial'
    detail: text('detail'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('automation_runs_rule_idx').on(t.ruleId),
    index('automation_runs_rule_request_idx').on(t.ruleId, t.requestId),
  ],
);

// On-call / rotation schedules — per project. Participants rotate every
// `rotationDays` days, handing off at `handoffTime` in `timezone`, anchored at `startDate`.
export const oncallSchedules = pgTable(
  'oncall_schedules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    timezone: text('timezone').notNull().default('UTC'),
    rotationDays: integer('rotation_days').notNull().default(7),
    handoffTime: text('handoff_time').notNull().default('09:00'), // 'HH:MM'
    startDate: text('start_date').notNull(),                       // civil date 'YYYY-MM-DD'
    participants: jsonb('participants').notNull().default('[]'),    // ordered userId[]
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('oncall_schedules_project_idx').on(t.projectId),
  ],
);

// ── Relations ─────────────────────────────────────────────────────────────────

export const organizationsRelations = relations(organizations, ({ many }) => ({
  projects: many(projects),
  users: many(users),
  auditLogs: many(auditLogs),
  mcpApiKeys: many(mcpApiKeys),
}));

export const projectsRelations = relations(projects, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [projects.orgId],
    references: [organizations.id],
  }),
  members: many(projectMembers),
  requests: many(requests),
  knowledgeSources: many(knowledgeSources),
}));

export const usersRelations = relations(users, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [users.orgId],
    references: [organizations.id],
  }),
  projectMemberships: many(projectMembers),
  requestsAsRequester: many(requests, { relationName: 'requester' }),
  requestsAsAssignee: many(requests, { relationName: 'assignee' }),
  comments: many(comments),
}));

export const requestsRelations = relations(requests, ({ one, many }) => ({
  project: one(projects, {
    fields: [requests.projectId],
    references: [projects.id],
  }),
  requester: one(users, {
    fields: [requests.requesterId],
    references: [users.id],
    relationName: 'requester',
  }),
  assignee: one(users, {
    fields: [requests.assigneeId],
    references: [users.id],
    relationName: 'assignee',
  }),
  comments: many(comments),
  attachments: many(attachments),
  aiActions: many(aiActions),
}));

export const knowledgeSourcesRelations = relations(
  knowledgeSources,
  ({ one, many }) => ({
    project: one(projects, {
      fields: [knowledgeSources.projectId],
      references: [projects.id],
    }),
    chunks: many(knowledgeChunks),
  }),
);
