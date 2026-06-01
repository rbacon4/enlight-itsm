import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import http from 'http';
import { z } from 'zod';
import { db } from './db.js';
import { requests, projects, comments, mcpApiKeys } from '../../api/src/db/schema.js';
import { eq, and, desc, inArray } from 'drizzle-orm';
import bcrypt from 'bcrypt';
import { logger } from './logger.js';

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
