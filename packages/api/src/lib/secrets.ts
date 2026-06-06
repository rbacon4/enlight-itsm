/**
 * Centralized secrets manager.
 *
 * Org-scoped named secrets encrypted at rest via secretCrypto.
 * Referenced in automation/checklist templates as {{secrets.NAME}}.
 */
import { db } from '../db/client.js';
import { orgSecrets } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { encryptSecret, decryptSecret } from './secretCrypto.js';
import { logger } from './logger.js';

/** Resolve and decrypt a named secret for an org. Returns null if not found. */
export async function resolveSecret(orgId: string, name: string): Promise<string | null> {
  try {
    const [row] = await db
      .select({ id: orgSecrets.id, value: orgSecrets.value })
      .from(orgSecrets)
      .where(and(eq(orgSecrets.orgId, orgId), eq(orgSecrets.name, name)))
      .limit(1);
    if (!row) return null;
    // Mark last used
    await db.update(orgSecrets).set({ lastUsedAt: new Date() }).where(eq(orgSecrets.id, row.id));
    return decryptSecret(row.value);
  } catch (err) {
    logger.warn('resolveSecret failed', { orgId, name, err });
    return null;
  }
}

/** Store a new or updated secret (encrypts value). */
export async function storeSecret(orgId: string, name: string, plainValue: string): Promise<void> {
  const encrypted = encryptSecret(plainValue);
  await db
    .insert(orgSecrets)
    .values({ orgId, name, value: encrypted, description: '' })
    .onConflictDoUpdate({
      target: [orgSecrets.orgId, orgSecrets.name],
      set: { value: encrypted, updatedAt: new Date() },
    });
}
