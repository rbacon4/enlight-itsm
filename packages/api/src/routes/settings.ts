/**
 * Settings routes for directory integrations:
 *   - Rippling IT:  GET/PUT /settings/rippling, POST /settings/rippling/test, POST /settings/rippling/sync
 *   - JumpCloud:    GET/PUT /settings/jumpcloud, POST /settings/jumpcloud/test, POST /settings/jumpcloud/sync
 *   - Okta:         GET/PUT /settings/okta,      POST /settings/okta/test,      POST /settings/okta/sync
 */
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/client.js';
import { organizations } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { encryptOrgSettings, decryptOrgSettings } from '../lib/secretCrypto.js';
import { makeRipplingClient } from '../lib/rippling.js';
import { makeJumpCloudClient } from '../lib/jumpcloud.js';
import { makeOktaClient } from '../lib/okta.js';
import type { OrganizationSettings } from '@enlight/shared';

const router = Router();
router.use(requireAuth);
router.use(requirePermission('org.manage_settings'));

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getOrgSettings(orgId: string): Promise<OrganizationSettings> {
  const [org] = await db.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
  return decryptOrgSettings((org?.settings ?? {}) as OrganizationSettings);
}

async function saveNestedSettings(orgId: string, key: keyof OrganizationSettings, value: Record<string, unknown>): Promise<void> {
  const [existing] = await db.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
  const current = (existing?.settings ?? {}) as OrganizationSettings;
  const merged: OrganizationSettings = { ...current, [key]: { ...(current[key] as Record<string, unknown> ?? {}), ...value } };
  const encrypted = encryptOrgSettings(merged);
  await db.update(organizations).set({ settings: encrypted as unknown as Record<string, unknown>, updatedAt: new Date() }).where(eq(organizations.id, orgId));
}

// ── Rippling ──────────────────────────────────────────────────────────────────

const ripplingSchema = z.object({
  apiToken: z.string().max(500).optional(),
  apiVersion: z.string().max(32).optional(),
  syncEnabled: z.boolean().optional(),
  offboardingEnabled: z.boolean().optional(),
  deviceUnenrollEnabled: z.boolean().optional(),
});

router.get('/rippling', async (req, res, next) => {
  try {
    const settings = await getOrgSettings(req.user!.orgId);
    const r = settings.rippling ?? {};
    // Redact token
    res.json({ ...r, apiToken: r.apiToken ? '••••••••' : '', apiTokenConfigured: Boolean(r.apiToken) });
  } catch (err) { next(err); }
});

router.put('/rippling', async (req, res, next) => {
  try {
    const body = ripplingSchema.parse(req.body);
    const [existing] = await db.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, req.user!.orgId)).limit(1);
    const current = decryptOrgSettings((existing?.settings ?? {}) as OrganizationSettings);
    const prev = current.rippling ?? {};

    const next: Record<string, unknown> = { ...prev };
    if (body.apiToken !== undefined) {
      next['apiToken'] = body.apiToken || prev.apiToken || ''; // blank = keep existing
    }
    if (body.apiVersion !== undefined) next['apiVersion'] = body.apiVersion;
    if (body.syncEnabled !== undefined) next['syncEnabled'] = body.syncEnabled;
    if (body.offboardingEnabled !== undefined) next['offboardingEnabled'] = body.offboardingEnabled;
    if (body.deviceUnenrollEnabled !== undefined) next['deviceUnenrollEnabled'] = body.deviceUnenrollEnabled;

    // Preserve existing token when blank sent (masked UI)
    if (!next['apiToken'] && prev.apiToken) next['apiToken'] = prev.apiToken;

    await saveNestedSettings(req.user!.orgId, 'rippling', next);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.post('/rippling/test', async (req, res, next) => {
  try {
    const settings = await getOrgSettings(req.user!.orgId);
    const client = makeRipplingClient(settings);
    const result = await client.testConnection();
    res.json(result);
  } catch (err) { next(err); }
});

router.post('/rippling/sync', async (req, res, next) => {
  try {
    // Fire sync job immediately for this org
    const { Queue } = await import('bullmq');
    const q = new Queue('rippling-sync', { connection: { url: process.env['REDIS_URL'] ?? 'redis://localhost:6379' } });
    await q.add('sync', { orgId: req.user!.orgId }, { removeOnComplete: 5, removeOnFail: 10 });
    res.json({ ok: true, message: 'Rippling sync job queued' });
  } catch (err) { next(err); }
});

// ── JumpCloud ─────────────────────────────────────────────────────────────────

const jumpcloudSchema = z.object({
  authMode: z.enum(['apiKey', 'serviceAccount']).optional(),
  apiKey: z.string().max(500).optional(),
  clientId: z.string().max(200).optional(),
  clientSecret: z.string().max(500).optional(),
  syncEnabled: z.boolean().optional(),
  offboardingEnabled: z.boolean().optional(),
  systemUnbindEnabled: z.boolean().optional(),
});

router.get('/jumpcloud', async (req, res, next) => {
  try {
    const settings = await getOrgSettings(req.user!.orgId);
    const j = settings.jumpcloud ?? {};
    res.json({
      ...j,
      apiKey: j.apiKey ? '••••••••' : '',
      apiKeyConfigured: Boolean(j.apiKey),
      clientSecret: j.clientSecret ? '••••••••' : '',
      clientSecretConfigured: Boolean(j.clientSecret),
      cachedAccessToken: undefined, // never expose
    });
  } catch (err) { next(err); }
});

router.put('/jumpcloud', async (req, res, next) => {
  try {
    const body = jumpcloudSchema.parse(req.body);
    const [existing] = await db.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, req.user!.orgId)).limit(1);
    const current = decryptOrgSettings((existing?.settings ?? {}) as OrganizationSettings);
    const prev = current.jumpcloud ?? {};
    const next: Record<string, unknown> = { ...prev };

    if (body.authMode !== undefined) next['authMode'] = body.authMode;
    if (body.apiKey !== undefined) next['apiKey'] = body.apiKey || prev.apiKey || '';
    if (body.clientId !== undefined) next['clientId'] = body.clientId;
    if (body.clientSecret !== undefined) next['clientSecret'] = body.clientSecret || prev.clientSecret || '';
    if (body.syncEnabled !== undefined) next['syncEnabled'] = body.syncEnabled;
    if (body.offboardingEnabled !== undefined) next['offboardingEnabled'] = body.offboardingEnabled;
    if (body.systemUnbindEnabled !== undefined) next['systemUnbindEnabled'] = body.systemUnbindEnabled;

    // Preserve existing secrets when blank
    if (!next['apiKey'] && prev.apiKey) next['apiKey'] = prev.apiKey;
    if (!next['clientSecret'] && prev.clientSecret) next['clientSecret'] = prev.clientSecret;

    await saveNestedSettings(req.user!.orgId, 'jumpcloud', next);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.post('/jumpcloud/test', async (req, res, next) => {
  try {
    const settings = await getOrgSettings(req.user!.orgId);
    const client = makeJumpCloudClient(settings, req.user!.orgId);
    const result = await client.testConnection();
    res.json(result);
  } catch (err) { next(err); }
});

router.post('/jumpcloud/sync', async (req, res, next) => {
  try {
    const { Queue } = await import('bullmq');
    const q = new Queue('jumpcloud-sync', { connection: { url: process.env['REDIS_URL'] ?? 'redis://localhost:6379' } });
    await q.add('sync', { orgId: req.user!.orgId }, { removeOnComplete: 5, removeOnFail: 10 });
    res.json({ ok: true, message: 'JumpCloud sync job queued' });
  } catch (err) { next(err); }
});

// ── Okta ──────────────────────────────────────────────────────────────────────

const oktaSchema = z.object({
  domain: z.string().max(200).optional(),
  authMode: z.enum(['ssws', 'oauth']).optional(),
  apiToken: z.string().max(500).optional(),
  clientId: z.string().max(200).optional(),
  privateKeyJwk: z.string().max(10_000).optional(),
  syncEnabled: z.boolean().optional(),
  offboardingEnabled: z.boolean().optional(),
  revokeSessionsEnabled: z.boolean().optional(),
  removeGroupsEnabled: z.boolean().optional(),
});

router.get('/okta', async (req, res, next) => {
  try {
    const settings = await getOrgSettings(req.user!.orgId);
    const o = settings.okta ?? {};
    res.json({
      ...o,
      apiToken: o.apiToken ? '••••••••' : '',
      apiTokenConfigured: Boolean(o.apiToken),
      privateKeyJwk: o.privateKeyJwk ? '••••••••' : '',
      privateKeyJwkConfigured: Boolean(o.privateKeyJwk),
      cachedAccessToken: undefined, // never expose
    });
  } catch (err) { next(err); }
});

router.put('/okta', async (req, res, next) => {
  try {
    const body = oktaSchema.parse(req.body);
    const [existing] = await db.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, req.user!.orgId)).limit(1);
    const current = decryptOrgSettings((existing?.settings ?? {}) as OrganizationSettings);
    const prev = current.okta ?? {};
    const next: Record<string, unknown> = { ...prev };

    if (body.domain !== undefined) next['domain'] = body.domain;
    if (body.authMode !== undefined) next['authMode'] = body.authMode;
    if (body.apiToken !== undefined) next['apiToken'] = body.apiToken || prev.apiToken || '';
    if (body.clientId !== undefined) next['clientId'] = body.clientId;
    if (body.privateKeyJwk !== undefined) next['privateKeyJwk'] = body.privateKeyJwk || prev.privateKeyJwk || '';
    if (body.syncEnabled !== undefined) next['syncEnabled'] = body.syncEnabled;
    if (body.offboardingEnabled !== undefined) next['offboardingEnabled'] = body.offboardingEnabled;
    if (body.revokeSessionsEnabled !== undefined) next['revokeSessionsEnabled'] = body.revokeSessionsEnabled;
    if (body.removeGroupsEnabled !== undefined) next['removeGroupsEnabled'] = body.removeGroupsEnabled;

    if (!next['apiToken'] && prev.apiToken) next['apiToken'] = prev.apiToken;
    if (!next['privateKeyJwk'] && prev.privateKeyJwk) next['privateKeyJwk'] = prev.privateKeyJwk;

    await saveNestedSettings(req.user!.orgId, 'okta', next);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.post('/okta/test', async (req, res, next) => {
  try {
    const settings = await getOrgSettings(req.user!.orgId);
    const client = makeOktaClient(settings, req.user!.orgId);
    const result = await client.testConnection();
    res.json(result);
  } catch (err) { next(err); }
});

router.post('/okta/sync', async (req, res, next) => {
  try {
    const { Queue } = await import('bullmq');
    const q = new Queue('okta-sync', { connection: { url: process.env['REDIS_URL'] ?? 'redis://localhost:6379' } });
    await q.add('sync', { orgId: req.user!.orgId }, { removeOnComplete: 5, removeOnFail: 10 });
    res.json({ ok: true, message: 'Okta sync job queued' });
  } catch (err) { next(err); }
});

export { router as settingsRouter };
