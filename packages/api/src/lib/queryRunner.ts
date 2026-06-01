import { pool } from '../db/client.js';

/**
 * Validates that a SQL string is a safe read-only SELECT.
 * Returns an error message string, or null if valid.
 */
export function validateQuerySQL(query: string): string | null {
  const stripped = query
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .trim();

  if (!stripped) return 'Query cannot be empty.';

  if (!/^select\s/i.test(stripped)) {
    return 'Only SELECT statements are allowed. Your query must start with SELECT.\n' +
           'For complex queries, use subqueries: SELECT ... FROM (WITH cte AS (...) SELECT ...) q';
  }

  const blocked = /\b(insert|update|delete|drop|create|alter|truncate|copy|grant|revoke|execute|exec|pg_read_file|pg_write_file|pg_ls_dir|pg_stat_file|pg_sleep|lo_import|lo_export|dblink)\b/i;
  if (blocked.test(stripped)) {
    return 'Query contains a disallowed operation.';
  }

  const withoutTrailing = stripped.replace(/;\s*$/, '');
  if (withoutTrailing.includes(';')) {
    return 'Multiple statements are not allowed.';
  }

  return null;
}

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
  durationMs: number;
}

/**
 * Wraps the user's SELECT in org-scoped CTEs, executes in a READ ONLY
 * transaction with a 5s statement timeout, and returns column names + rows.
 * At most MAX_ROWS rows are returned; `truncated` is true if more existed.
 */
export async function runOrgQuery(
  userQuery: string,
  orgId: string,
  maxRows = 100,
): Promise<QueryResult> {
  const wrapped = `
    WITH
      organizations AS (
        SELECT id, name, created_at
        FROM organizations
        WHERE id = $1
      ),
      projects AS (
        SELECT id, name, slug, key, description, icon, ai_model, ai_autonomous_mode,
               status, access_type, last_ticket_number, created_at, updated_at
        FROM projects
        WHERE org_id = $1
      ),
      users AS (
        SELECT id, name, email, global_role, created_at
        FROM users
        WHERE org_id = $1
      ),
      requests AS (
        SELECT r.id, r.ticket_number, r.title, r.description, r.status, r.priority,
               r.category, r.subcategory, r.project_id, r.requester_id, r.assignee_id,
               r.created_at, r.updated_at, r.resolved_at
        FROM requests r
        JOIN projects p ON r.project_id = p.id
      ),
      project_members AS (
        SELECT pm.project_id, pm.user_id, pm.role, pm.created_at
        FROM project_members pm
        JOIN projects p ON pm.project_id = p.id
      ),
      comments AS (
        SELECT c.id, c.request_id, c.author_id, c.body, c.is_internal,
               c.ai_generated, c.created_at
        FROM comments c
        JOIN requests r ON c.request_id = r.id
      ),
      attachments AS (
        SELECT a.id, a.request_id, a.uploader_id, a.filename,
               a.content_type, a.size_bytes, a.created_at
        FROM attachments a
        JOIN requests r ON a.request_id = r.id
      ),
      knowledge_sources AS (
        SELECT ks.id, ks.project_id, ks.type, ks.file_type, ks.status,
               ks.document_count, ks.last_synced_at, ks.created_at, ks.updated_at
        FROM knowledge_sources ks
        JOIN projects p ON ks.project_id = p.id
      ),
      ai_actions AS (
        SELECT aa.id, aa.request_id, aa.action_type, aa.model,
               aa.input_tokens, aa.output_tokens, aa.confidence, aa.created_at
        FROM ai_actions aa
        JOIN requests r ON aa.request_id = r.id
      ),
      audit_logs AS (
        SELECT id, actor_id, action, entity_type, entity_id, created_at
        FROM audit_logs
        WHERE org_id = $1
      ),
      mcp_api_keys AS (
        SELECT id, name, permission_level, project_ids, created_at, last_used_at
        FROM mcp_api_keys
        WHERE org_id = $1
      ),
      dashboard_layouts   AS (SELECT NULL::uuid AS id WHERE FALSE),
      analytics_reports   AS (SELECT NULL::uuid AS id WHERE FALSE),
      knowledge_chunks    AS (SELECT NULL::uuid AS id WHERE FALSE),
      _user_result AS (
        ${userQuery}
      )
    SELECT * FROM _user_result LIMIT ${maxRows + 1}
  `;

  const client = await pool.connect();
  const t0 = Date.now();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query(`SET LOCAL statement_timeout = '5000'`);
    await client.query(`SET LOCAL lock_timeout   = '1000'`);

    const result = await client.query(wrapped, [orgId]);

    await client.query('ROLLBACK');

    const durationMs = Date.now() - t0;
    const truncated  = result.rows.length > maxRows;
    const rows       = truncated ? result.rows.slice(0, maxRows) : result.rows;
    const columns    = result.fields.map((f: { name: string }) => f.name);

    return { columns, rows, rowCount: rows.length, truncated, durationMs };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
