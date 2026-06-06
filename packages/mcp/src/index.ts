import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import http from 'http';
import { z } from 'zod';
import { db } from './db.js';
import { requests, projects, comments, mcpApiKeys, organizations, ripplingWorkers, jumpcloudUsers, oktaUsers } from '../../api/src/db/schema.js';
import { eq, and, desc, inArray } from 'drizzle-orm';
import bcrypt from 'bcrypt';
import { logger } from './logger.js';
import { decryptOrgSettings } from '../../api/src/lib/secretCrypto.js';
import { makeRipplingClient } from '../../api/src/lib/rippling.js';
import { makeJumpCloudClient } from '../../api/src/lib/jumpcloud.js';
import { makeOktaClient } from '../../api/src/lib/okta.js';
import type { OrganizationSettings } from '@enlight/shared';

// ── Auth helper ───────────────────────────────────────────────────────────────

async function verifyApiKey(rawKey: string) {
  const keys = await db.select().from(mcpApiKeys);
  for (const key of keys) {
    if (await bcrypt.compare(rawKey, key.keyHash)) {
      await db
        .update(mcpApiKeys)
        .set({ lastUsedAt: new Date() })
        .where(eq(mcpApiKeys.id, key.id));
      return key;
    }
  }
  return null;
}

// ── MCP Server ────────────────────────────────────────────────────────────────

function createServer() {
  const server = new McpServer({
    name: 'enlight',
    version: '1.0.0',
  });

  // Read tools

  server.tool(
    'get_request',
    'Retrieve a single request by ID with full details and comment history',
    { requestId: z.string().describe('UUID of the request') },
    async ({ requestId }) => {
      const [request] = await db
        .select()
        .from(requests)
        .where(eq(requests.id, requestId))
        .limit(1);

      if (!request) return { content: [{ type: 'text', text: 'Request not found' }] };

      const requestComments = await db
        .select()
        .from(comments)
        .where(eq(comments.requestId, requestId))
        .orderBy(comments.createdAt);

      return {
        content: [{ type: 'text', text: JSON.stringify({ ...request, comments: requestComments }, null, 2) }],
      };
    },
  );

  server.tool(
    'list_requests',
    'List requests with optional filtering by project, status, priority, and assignee',
    {
      projectId: z.string().describe('Filter by project ID'),
      status: z.enum(['open', 'in_progress', 'pending_user', 'resolved', 'closed']).optional(),
      priority: z.enum(['critical', 'high', 'medium', 'low']).optional(),
      assigneeId: z.string().optional(),
      limit: z.number().int().min(1).max(100).default(25),
    },
    async ({ projectId, status, priority, assigneeId, limit }) => {
      const conditions = [eq(requests.projectId, projectId)];
      if (status) conditions.push(eq(requests.status, status));
      if (priority) conditions.push(eq(requests.priority, priority));
      if (assigneeId) conditions.push(eq(requests.assigneeId, assigneeId));

      const rows = await db
        .select()
        .from(requests)
        .where(and(...conditions))
        .orderBy(desc(requests.createdAt))
        .limit(limit);

      return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
    },
  );

  server.tool(
    'get_project',
    'Retrieve project metadata and configuration',
    { projectId: z.string() },
    async ({ projectId }) => {
      const [project] = await db
        .select()
        .from(projects)
        .where(eq(projects.id, projectId))
        .limit(1);

      if (!project) return { content: [{ type: 'text', text: 'Project not found' }] };
      return { content: [{ type: 'text', text: JSON.stringify(project, null, 2) }] };
    },
  );

  server.tool(
    'list_projects',
    'List all projects accessible to the API key',
    {},
    async () => {
      const rows = await db.select().from(projects).where(eq(projects.status, 'active'));
      return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
    },
  );

  // Write tools

  server.tool(
    'create_request',
    'Create a new support request in a project',
    {
      projectId: z.string(),
      title: z.string().min(1).max(500),
      description: z.string().default(''),
      priority: z.enum(['critical', 'high', 'medium', 'low']).default('medium'),
      requesterId: z.string().describe('UUID of the user submitting the request'),
    },
    async ({ projectId, title, description, priority, requesterId }) => {
      const [request] = await db
        .insert(requests)
        .values({ projectId, title, description, priority, requesterId })
        .returning();

      return { content: [{ type: 'text', text: JSON.stringify(request, null, 2) }] };
    },
  );

  server.tool(
    'add_comment',
    'Add a comment to a request',
    {
      requestId: z.string(),
      body: z.string().min(1),
      authorId: z.string().describe('UUID of the author'),
      isInternal: z.boolean().default(false),
    },
    async ({ requestId, body, authorId, isInternal }) => {
      const [comment] = await db
        .insert(comments)
        .values({ requestId, body, authorId, isInternal })
        .returning();

      return { content: [{ type: 'text', text: JSON.stringify(comment, null, 2) }] };
    },
  );

  server.tool(
    'update_request',
    'Update request fields (status, priority, assignee, custom fields)',
    {
      requestId: z.string(),
      status: z.enum(['open', 'in_progress', 'pending_user', 'resolved', 'closed']).optional(),
      priority: z.enum(['critical', 'high', 'medium', 'low']).optional(),
      assigneeId: z.string().optional(),
      title: z.string().optional(),
      description: z.string().optional(),
    },
    async ({ requestId, ...fields }) => {
      const updates = Object.fromEntries(
        Object.entries(fields).filter(([, v]) => v !== undefined),
      );
      const [updated] = await db
        .update(requests)
        .set({ ...updates, updatedAt: new Date() })
        .where(eq(requests.id, requestId))
        .returning();

      if (!updated) return { content: [{ type: 'text', text: 'Request not found' }] };
      return { content: [{ type: 'text', text: JSON.stringify(updated, null, 2) }] };
    },
  );

  // ── Directory integration tools ──────────────────────────────────────────────

  server.tool(
    'rippling_sync',
    'Trigger an immediate Rippling IT directory sync for the specified org. Queues a background job.',
    { orgId: z.string().describe('The org UUID to sync') },
    async ({ orgId }) => {
      try {
        const { Queue } = await import('bullmq');
        const q = new Queue('rippling-sync', { connection: { url: process.env['REDIS_URL'] ?? 'redis://localhost:6379' } });
        await q.add('sync', { orgId }, { removeOnComplete: 5, removeOnFail: 10 });
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, message: 'Rippling sync job queued' }) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }) }] };
      }
    },
  );

  server.tool(
    'rippling_offboard',
    'Offboard a departing employee in Rippling IT. By default runs as a dry-run (mock). Set confirm: true to execute.',
    {
      orgId: z.string(),
      email: z.string(),
      confirm: z.boolean().default(false).describe('Set to true to actually execute; false = dry-run (mock mode)'),
    },
    async ({ orgId, email, confirm }) => {
      try {
        const [org] = await db.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
        if (!org) return { content: [{ type: 'text', text: 'Org not found' }] };
        const settings = decryptOrgSettings((org.settings ?? {}) as OrganizationSettings);
        const client = confirm ? makeRipplingClient(settings) : makeRipplingClient({ ...settings, rippling: { ...settings.rippling } });
        const unenroll = settings.rippling?.deviceUnenrollEnabled ?? false;
        const result = confirm
          ? await client.offboardByEmail(email, unenroll)
          : { deactivated: true, appsRevoked: true, devicesUnenrolled: 0, mock: true };
        return { content: [{ type: 'text', text: JSON.stringify({ ...result, dryRun: !confirm }) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }] };
      }
    },
  );

  server.tool(
    'jumpcloud_sync',
    'Trigger an immediate JumpCloud directory sync for the specified org.',
    { orgId: z.string() },
    async ({ orgId }) => {
      try {
        const { Queue } = await import('bullmq');
        const q = new Queue('jumpcloud-sync', { connection: { url: process.env['REDIS_URL'] ?? 'redis://localhost:6379' } });
        await q.add('sync', { orgId }, { removeOnComplete: 5, removeOnFail: 10 });
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, message: 'JumpCloud sync job queued' }) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }) }] };
      }
    },
  );

  server.tool(
    'jumpcloud_offboard',
    'Offboard a departing employee in JumpCloud. By default runs as a dry-run. Set confirm: true to execute.',
    {
      orgId: z.string(),
      email: z.string(),
      confirm: z.boolean().default(false),
    },
    async ({ orgId, email, confirm }) => {
      try {
        const [org] = await db.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
        if (!org) return { content: [{ type: 'text', text: 'Org not found' }] };
        const settings = decryptOrgSettings((org.settings ?? {}) as OrganizationSettings);
        const client = makeJumpCloudClient(settings, orgId);
        const unbind = settings.jumpcloud?.systemUnbindEnabled ?? false;
        const result = confirm
          ? await client.offboardByEmail(email, unbind)
          : { suspended: true, groupsRemoved: 2, systemsUnbound: 0, mock: true };
        return { content: [{ type: 'text', text: JSON.stringify({ ...result, dryRun: !confirm }) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }] };
      }
    },
  );

  server.tool(
    'okta_sync',
    'Trigger an immediate Okta directory sync for the specified org.',
    { orgId: z.string() },
    async ({ orgId }) => {
      try {
        const { Queue } = await import('bullmq');
        const q = new Queue('okta-sync', { connection: { url: process.env['REDIS_URL'] ?? 'redis://localhost:6379' } });
        await q.add('sync', { orgId }, { removeOnComplete: 5, removeOnFail: 10 });
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, message: 'Okta sync job queued' }) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }) }] };
      }
    },
  );

  server.tool(
    'okta_offboard',
    'Offboard a departing employee in Okta. By default runs as a dry-run. Set confirm: true to execute.',
    {
      orgId: z.string(),
      email: z.string(),
      confirm: z.boolean().default(false),
    },
    async ({ orgId, email, confirm }) => {
      try {
        const [org] = await db.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
        if (!org) return { content: [{ type: 'text', text: 'Org not found' }] };
        const settings = decryptOrgSettings((org.settings ?? {}) as OrganizationSettings);
        const client = makeOktaClient(settings, orgId);
        const revokeSessions = settings.okta?.revokeSessionsEnabled ?? true;
        const removeGroups = settings.okta?.removeGroupsEnabled ?? true;
        const result = confirm
          ? await client.offboardByEmail(email, revokeSessions, removeGroups)
          : { deactivated: true, sessionRevoked: true, groupsRemoved: 2, previousStatus: 'ACTIVE', mock: true };
        return { content: [{ type: 'text', text: JSON.stringify({ ...result, dryRun: !confirm }) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }] };
      }
    },
  );

  // Resources

  server.resource(
    'enlight-requests',
    'enlight://projects/{projectId}/requests',
    async (uri) => {
      const match = uri.href.match(/enlight:\/\/projects\/([^/]+)\/requests/);
      if (!match?.[1]) return { contents: [] };

      const rows = await db
        .select()
        .from(requests)
        .where(eq(requests.projectId, match[1]))
        .orderBy(desc(requests.createdAt))
        .limit(50);

      return {
        contents: [{ uri: uri.href, text: JSON.stringify(rows, null, 2), mimeType: 'application/json' }],
      };
    },
  );

  return server;
}

// ── Transport selection ───────────────────────────────────────────────────────

const isStdio = process.argv.includes('--stdio');

if (isStdio) {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('Enlight MCP server running (stdio)');
} else {
  const PORT = parseInt(process.env['MCP_PORT'] ?? '3001', 10);
  const server = createServer();

  const httpServer = http.createServer(async (req, res) => {
    const apiKey = req.headers['x-api-key'] as string | undefined;
    if (!apiKey) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'API key required' }));
      return;
    }

    const keyRecord = await verifyApiKey(apiKey);
    if (!keyRecord) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid API key' }));
      return;
    }

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  });

  httpServer.listen(PORT, () => {
    logger.info(`Enlight MCP server running on port ${PORT}`);
  });
}
