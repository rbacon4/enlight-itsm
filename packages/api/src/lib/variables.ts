/**
 * Global variables manager.
 *
 * Org-scoped named non-secret key-value pairs.
 * Referenced in automation/checklist templates as {{vars.NAME}}.
 */
import { db } from '../db/client.js';
import { orgVariables } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { logger } from './logger.js';

/** Resolve a named variable for an org. Returns null if not found. */
export async function resolveVariable(orgId: string, name: string): Promise<string | null> {
  try {
    const [row] = await db
      .select({ value: orgVariables.value })
      .from(orgVariables)
      .where(and(eq(orgVariables.orgId, orgId), eq(orgVariables.name, name)))
      .limit(1);
    return row?.value ?? null;
  } catch (err) {
    logger.warn('resolveVariable failed', { orgId, name, err });
    return null;
  }
}

/**
 * Resolve all {{secrets.X}} and {{vars.X}} template references in a string.
 * Unknown references are left as-is.
 */
export async function resolveTemplateVars(orgId: string, template: string): Promise<string> {
  const { resolveSecret } = await import('./secrets.js');
  // Collect unique refs to avoid redundant DB queries
  const secretRefs = new Set<string>();
  const varRefs = new Set<string>();
  for (const [, type, name] of template.matchAll(/\{\{(secrets|vars)\.([A-Z0-9_]+)\}\}/g)) {
    if (type === 'secrets') secretRefs.add(name!);
    else varRefs.add(name!);
  }

  const secretValues = new Map<string, string>();
  const varValues = new Map<string, string>();

  for (const name of secretRefs) {
    const v = await resolveSecret(orgId, name);
    if (v !== null) secretValues.set(name, v);
  }
  for (const name of varRefs) {
    const v = await resolveVariable(orgId, name);
    if (v !== null) varValues.set(name, v);
  }

  return template.replace(/\{\{(secrets|vars)\.([A-Z0-9_]+)\}\}/g, (m, type, name) => {
    if (type === 'secrets') return secretValues.get(name!) ?? m;
    return varValues.get(name!) ?? m;
  });
}
