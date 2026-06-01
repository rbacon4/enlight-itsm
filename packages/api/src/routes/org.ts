import { Router } from 'express';
import crypto from 'crypto';
import { db } from '../db/client.js';
import { organizations, mcpApiKeys, users } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { Errors } from '../lib/errors.js';
import { z } from 'zod';
import { startSlack, stopSlack, isSlackRunning } from '../slack/index.js';
import { fetchIdpMetadata } from '../lib/samlMetadata.js';
import { encryptOrgSettings, decryptOrgSettings } from '../lib/secretCrypto.js';
import { getStorageBackend } from '../lib/storage.js';
import { verifyLicense, clearLicenseCache, isLicensingEnabled } from '../lib/license.js';
import type { OrganizationSettings, StorageProvider } from '@enlight/shared';

const router = Router();
router.use(requireAuth);

// ── GET /org ──────────────────────────────────────────────────────────────────

router.get('/', async (req, res, next) => {
  try {
    const [org] = await db
      .select({
        id: organizations.id,
        name: organizations.name,
        settings: organizations.settings,
        emailSenderConfig: organizations.emailSenderConfig,
        samlConfig: organizations.samlConfig,
        createdAt: organizations.createdAt,
      })
      .from(organizations)
      .where(eq(organizations.id, req.user!.orgId))
      .limit(1);

    if (!org) { next(Errors.notFound('Organization')); return; }
    // GET /org is readable by any authenticated user (the web loads branding from
    // it), but only managers may see the org's secrets. Redact for everyone else.
    const canManage = req.user!.permissions.includes('org.manage_settings');
    const decrypted = decryptOrgSettings((org.settings ?? {}) as OrganizationSettings) as Record<string, unknown>;
    let settings = decrypted;
    let emailSenderConfig: unknown = org.emailSenderConfig;
    let samlConfig: unknown = org.samlConfig;
    if (canManage) {
      // Never ship the full service-account key file to the browser — redact it and
      // expose only whether one is configured. The UI sends a blank value to keep it.
      const gcp = settings['gcp'] as Record<string, unknown> | undefined;
      if (gcp) {
        const configured = Boolean(gcp['serviceAccountJson']);
        settings['gcp'] = { ...gcp, serviceAccountJson: '', serviceAccountConfigured: configured };
      }
      // Redact the M365 client secret; expose only whether one is configured.
      const off = settings['offboarding'] as Record<string, unknown> | undefined;
      const ms = off?.['microsoft'] as Record<string, unknown> | undefined;
      if (off && ms) {
        const configured = Boolean(ms['clientSecret']);
        off['microsoft'] = { ...ms, clientSecret: '', clientSecretConfigured: configured };
      }
      // Redact AWS / DigitalOcean secret access keys.
      for (const provider of ['aws', 'digitalocean'] as const) {
        const p = settings[provider] as Record<string, unknown> | undefined;
        if (p) settings[provider] = { ...p, secretAccessKey: '', secretAccessKeyConfigured: Boolean(p['secretAccessKey']) };
      }
    } else {
      // Strip every secret-bearing field for non-managers; keep branding + safe fields.
      const SECRET_KEYS = ['anthropicApiKey', 'voyageApiKey', 'openAiApiKey', 'slackBotToken', 'slackSigningSecret', 'slackAppToken'];
      const safe = { ...decrypted } as Record<string, unknown>;
      for (const k of SECRET_KEYS) delete safe[k];
      delete safe['gcp'];          // service-account key
      delete safe['aws'];          // S3 secret
      delete safe['digitalocean']; // Spaces secret
      // `offboarding` is non-secret config (domain/OUs/channel) — kept so the
      // Offboarding page works for operators who lack org.manage_settings. Strip
      // the nested M365 client secret though.
      const off = safe['offboarding'] as Record<string, unknown> | undefined;
      const ms = off?.['microsoft'] as Record<string, unknown> | undefined;
      if (off && ms) off['microsoft'] = { ...ms, clientSecret: '' };
      settings = safe;
      emailSenderConfig = null;
      samlConfig = null;
    }
    res.json({ ...org, settings, emailSenderConfig, samlConfig });
  } catch (err) { next(err); }
});

// ── PATCH /org ────────────────────────────────────────────────────────────────

const emailConfigSchema = z.object({
  senderDomain: z.string().min(1),
  senderName: z.string().min(1),
  smtpHost: z.string().optional(),
  smtpPort: z.number().int().min(1).max(65535).optional(),
  smtpUser: z.string().optional(),
  provider: z.enum(['smtp', 'sendgrid', 'mailgun']).optional(),
}).nullable();

const samlConfigSchema = z.object({
  idpMetadataUrl: z.string().url().optional(),
  idpMetadataXml: z.string().optional(),
  nameIdAttribute: z.string().default('nameID'),
  emailAttribute: z.string().default('email'),
  firstNameAttribute: z.string().default('firstName'),
  lastNameAttribute: z.string().default('lastName'),
  groupsAttribute: z.string().default('groups'),
  departmentAttribute: z.string().optional(),
  jobTitleAttribute: z.string().optional(),
  managerAttribute: z.string().optional(),
  cityAttribute: z.string().optional(),
  stateAttribute: z.string().optional(),
  countryAttribute: z.string().optional(),
}).nullable();

const updateOrgSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  settings: z.object({
    defaultModel: z.enum(['claude-opus-4-5', 'claude-sonnet-4-5', 'claude-haiku-4-5']).optional(),
    dataRetentionDays: z.number().int().min(7).max(3650).nullable().optional(),
    // null = clear the setting; undefined = leave unchanged
    brandName: z.string().max(60).nullable().optional(),
    brandPrimaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
    // Accepts a remote URL or a base64 data URI (data:image/...) — max 400 KB encoded
    brandLogoUrl: z.string().max(400_000).refine(
      v => v.startsWith('http') || v.startsWith('data:image/'),
      'Must be an http URL or a data:image URI',
    ).nullable().optional(),
    // AI API keys — stored per-org, override ANTHROPIC_API_KEY / VOYAGE_API_KEY env vars
    anthropicApiKey: z.string().max(200).nullable().optional(),
    voyageApiKey: z.string().max(200).nullable().optional(),
    openAiApiKey: z.string().max(200).nullable().optional(),
    embeddingProvider: z.enum(['voyage', 'openai']).nullable().optional(),
    // Slack credentials — stored per-org, override SLACK_* env vars
    slackBotToken: z.string().max(200).nullable().optional(),
    slackSigningSecret: z.string().max(200).nullable().optional(),
    slackAppToken: z.string().max(200).nullable().optional(),
    // Auto-provisioning
    approvedDomains: z.array(z.string().max(253)).max(50).nullable().optional(),
    autoProvisionRole: z.enum(['admin', 'agent', 'viewer', 'customer']).nullable().optional(),
    // Shared Google Cloud credentials (Workspace offboarding + GCS storage).
    gcp: z.object({
      projectId: z.string().max(120).optional(),
      serviceAccountJson: z.string().max(20_000).optional(),
      storageBucket: z.string().max(200).optional(),
    }).nullable().optional(),
    // AWS (S3) credentials.
    aws: z.object({
      accessKeyId: z.string().max(200).optional(),
      secretAccessKey: z.string().max(500).optional(),
      region: z.string().max(60).optional(),
      bucket: z.string().max(200).optional(),
      endpoint: z.string().max(300).optional(),
    }).nullable().optional(),
    // DigitalOcean Spaces (S3-compatible) credentials.
    digitalocean: z.object({
      accessKeyId: z.string().max(200).optional(),
      secretAccessKey: z.string().max(500).optional(),
      region: z.string().max(60).optional(),
      bucket: z.string().max(200).optional(),
    }).nullable().optional(),
    // Active object-storage backend for attachments.
    storageProvider: z.enum(['none', 'gcs', 's3', 'spaces']).optional(),
    // Google Workspace offboarding automation
    offboarding: z.object({
      enabled: z.boolean().optional(),
      googleAdminEmail: z.string().max(320).optional(),
      googleDomain: z.string().max(253).optional(),
      departedOuPath: z.string().max(300).optional(),
      archiveOuPath: z.string().max(300).optional(),
      auditChannel: z.string().max(120).optional(),
      // Empty string clears the selection; a UUID sets the tracking project.
      trackingProjectId: z.string().max(64).optional(),
      mockMode: z.boolean().optional(),
      // Microsoft 365 (Microsoft Graph) offboarding.
      microsoft: z.object({
        enabled: z.boolean().optional(),
        tenantId: z.string().max(200).optional(),
        clientId: z.string().max(200).optional(),
        clientSecret: z.string().max(500).optional(),
        transferToManager: z.boolean().optional(),
        mockMode: z.boolean().optional(),
      }).optional(),
    }).nullable().optional(),
  }).optional(),
  emailSenderConfig: emailConfigSchema.optional(),
  samlConfig: samlConfigSchema.optional(),
});

router.patch('/', requirePermission('org.manage_settings'), async (req, res, next) => {
  try {
    const body = updateOrgSchema.parse(req.body);

    // Merge settings so a partial update doesn't wipe existing keys
    const [existing] = await db
      .select({ settings: organizations.settings })
      .from(organizations)
      .where(eq(organizations.id, req.user!.orgId))
      .limit(1);

    type Updates = {
      updatedAt: Date;
      name?: string;
      settings?: Record<string, unknown>;
      emailSenderConfig?: unknown;
      samlConfig?: unknown;
    };
    const updates: Updates = { updatedAt: new Date() };

    if (body.name !== undefined) updates.name = body.name;
    if (body.settings !== undefined) {
      // Merge: null values remove the key, non-null values set it, undefined is skipped
      const merged: Record<string, unknown> = {
        ...(existing?.settings as Record<string, unknown> ?? {}),
      };
      for (const [key, val] of Object.entries(body.settings)) {
        if (val === null) {
          delete merged[key];
        } else if (val !== undefined) {
          merged[key] = val;
        }
      }
      const prevSettings = (existing?.settings as Record<string, unknown>) ?? {};
      // `gcp` and `offboarding` are nested objects edited from multiple tabs
      // (the Slack tab sets offboarding.enabled / trackingProjectId, the Google
      // Cloud tab sets gcp.*, the Offboarding tab sets the rest). Deep-merge each
      // onto the existing config so a partial update never wipes sibling fields.
      if (body.settings.offboarding !== undefined && body.settings.offboarding !== null) {
        const prevOff = prevSettings['offboarding'] as Record<string, unknown> | undefined;
        const nextOff = { ...(prevOff ?? {}), ...body.settings.offboarding } as Record<string, unknown>;
        // Deep-merge the nested microsoft block too, preserving the stored client
        // secret when the client sends a blank (masked) value.
        if (body.settings.offboarding.microsoft !== undefined) {
          const prevMs = (prevOff?.['microsoft'] as Record<string, unknown>) ?? {};
          const nextMs = { ...prevMs, ...body.settings.offboarding.microsoft } as Record<string, unknown>;
          if (!nextMs['clientSecret'] && prevMs['clientSecret']) nextMs['clientSecret'] = prevMs['clientSecret'];
          nextOff['microsoft'] = nextMs;
        }
        merged['offboarding'] = nextOff;
      }
      // For gcp, also preserve the stored service-account JSON when the client
      // sends a blank (masked) value, so saving other fields doesn't clear it.
      if (body.settings.gcp !== undefined && body.settings.gcp !== null) {
        const prevGcp = prevSettings['gcp'] as Record<string, unknown> | undefined;
        const nextGcp = { ...(prevGcp ?? {}), ...body.settings.gcp } as Record<string, unknown>;
        if (!nextGcp['serviceAccountJson'] && prevGcp?.['serviceAccountJson']) {
          nextGcp['serviceAccountJson'] = prevGcp['serviceAccountJson'];
        }
        merged['gcp'] = nextGcp;
      }
      // AWS / DigitalOcean: deep-merge + preserve the stored secret access key when blank.
      for (const provider of ['aws', 'digitalocean'] as const) {
        const incoming = body.settings[provider];
        if (incoming !== undefined && incoming !== null) {
          const prev = prevSettings[provider] as Record<string, unknown> | undefined;
          const next = { ...(prev ?? {}), ...incoming } as Record<string, unknown>;
          if (!next['secretAccessKey'] && prev?.['secretAccessKey']) next['secretAccessKey'] = prev['secretAccessKey'];
          merged[provider] = next;
        }
      }
      // Encrypt secret fields (API keys, Slack tokens, service-account JSON, cloud secrets) before the DB.
      updates.settings = encryptOrgSettings(merged as unknown as OrganizationSettings) as unknown as Record<string, unknown>;
    }
    if (body.emailSenderConfig !== undefined) updates.emailSenderConfig = body.emailSenderConfig;
    if (body.samlConfig !== undefined) updates.samlConfig = body.samlConfig;

    const [updated] = await db
      .update(organizations)
      .set(updates)
      .where(eq(organizations.id, req.user!.orgId))
      .returning({
        id: organizations.id,
        name: organizations.name,
        settings: organizations.settings,
        emailSenderConfig: organizations.emailSenderConfig,
        samlConfig: organizations.samlConfig,
        createdAt: organizations.createdAt,
      });

    if (!updated) { next(Errors.notFound('Organization')); return; }
    res.json({ ...updated, settings: decryptOrgSettings((updated.settings ?? {}) as OrganizationSettings) });
  } catch (err) { next(err); }
});

// ── GET /org/sso-connection ───────────────────────────────────────────────────
// Returns the Service Provider (SP) details a customer plugs into their IdP and
// SCIM client. URLs are org-scoped so each tenant gets a unique connection.

function ssoConnectionInfo(orgId: string) {
  const apiUrl = (process.env['API_URL'] ?? 'http://localhost:3000').replace(/\/+$/, '');
  return {
    entityId:    `${apiUrl}/saml/${orgId}/metadata`,
    acsUrl:      `${apiUrl}/auth/saml/${orgId}/acs`,
    scimBaseUrl: `${apiUrl}/scim/v2/${orgId}`,
  };
}

router.get('/sso-connection', requirePermission('org.manage_settings'), async (req, res, next) => {
  try {
    const [org] = await db
      .select({ scimTokenHash: organizations.scimTokenHash })
      .from(organizations)
      .where(eq(organizations.id, req.user!.orgId))
      .limit(1);

    if (!org) { next(Errors.notFound('Organization')); return; }

    res.json({
      ...ssoConnectionInfo(req.user!.orgId),
      scimTokenSet: !!org.scimTokenHash,
    });
  } catch (err) { next(err); }
});

// ── POST /org/scim-token ──────────────────────────────────────────────────────
// Generates a new SCIM bearer token, stores only its hash, and returns the raw
// token ONCE. Regenerating invalidates any previously issued token.

router.post('/scim-token', requirePermission('org.manage_settings'), async (req, res, next) => {
  try {
    const rawToken = `scim_${crypto.randomBytes(32).toString('hex')}`;
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

    const [updated] = await db
      .update(organizations)
      .set({ scimTokenHash: tokenHash, updatedAt: new Date() })
      .where(eq(organizations.id, req.user!.orgId))
      .returning({ id: organizations.id });

    if (!updated) { next(Errors.notFound('Organization')); return; }

    // Return raw token ONCE — only the hash is persisted.
    res.status(201).json({ token: rawToken });
  } catch (err) { next(err); }
});

// ── DELETE /org/scim-token ────────────────────────────────────────────────────
// Revokes the current SCIM token by clearing its stored hash.

router.delete('/scim-token', requirePermission('org.manage_settings'), async (req, res, next) => {
  try {
    const [updated] = await db
      .update(organizations)
      .set({ scimTokenHash: null, updatedAt: new Date() })
      .where(eq(organizations.id, req.user!.orgId))
      .returning({ id: organizations.id });

    if (!updated) { next(Errors.notFound('Organization')); return; }
    res.status(204).send();
  } catch (err) { next(err); }
});

// ── POST /org/validate-saml-metadata ──────────────────────────────────────────
// Fetches an IdP SAML metadata URL server-side and confirms it looks like valid
// IdP metadata, surfacing the entityID, SSO endpoint(s), and certificate status.

router.post('/validate-saml-metadata', requirePermission('org.manage_settings'), async (req, res, next) => {
  try {
    const { url } = z.object({ url: z.string().url() }).parse(req.body);

    const meta = await fetchIdpMetadata(url);
    if (!meta.ok) {
      res.json({ valid: false, httpStatus: meta.httpStatus, entityId: meta.entityId, error: meta.error });
      return;
    }

    res.json({
      valid: true,
      httpStatus: meta.httpStatus,
      entityId: meta.entityId,
      ssoUrls: meta.ssoUrls,
      bindings: meta.bindings,
      hasCertificate: (meta.certs?.length ?? 0) > 0,
    });
  } catch (err) { next(err); }
});

// ── GET /org/slack/status ─────────────────────────────────────────────────────

router.get('/slack/status', async (req, res, next) => {
  try {
    const running = isSlackRunning();
    let teamName: string | undefined;
    let botName: string | undefined;

    if (running) {
      try {
        const { getSlackApp } = await import('../slack/app.js');
        const info = await getSlackApp().client.auth.test();
        teamName = info.team as string | undefined;
        botName  = info.user as string | undefined;
      } catch (_e) {
        // Non-fatal — just return running: true without team info
      }
    }

    res.json({ running, teamName, botName });
  } catch (err) { next(err); }
});

// ── POST /org/slack/reconnect ─────────────────────────────────────────────────

router.post('/slack/reconnect', requirePermission('org.manage_settings'), async (req, res, next) => {
  try {
    // Read current org settings to get stored credentials
    const [org] = await db
      .select({ settings: organizations.settings })
      .from(organizations)
      .where(eq(organizations.id, req.user!.orgId))
      .limit(1);

    const s = decryptOrgSettings((org?.settings ?? {}) as OrganizationSettings);

    const botToken      = s.slackBotToken      || process.env['SLACK_BOT_TOKEN'];
    const signingSecret = s.slackSigningSecret  || process.env['SLACK_SIGNING_SECRET'];
    const appToken      = s.slackAppToken       || process.env['SLACK_APP_TOKEN'];

    if (!botToken) {
      res.status(400).json({ error: 'NOT_CONFIGURED', message: 'No Slack Bot Token found in settings or environment.' });
      return;
    }

    await startSlack({ botToken, ...(signingSecret ? { signingSecret } : {}), ...(appToken ? { appToken } : {}) });
    res.json({ ok: true });
  } catch (err: unknown) {
    // Return the Slack error message to the UI rather than a generic 500
    const msg = err instanceof Error ? err.message : String(err);
    res.status(502).json({ error: 'SLACK_ERROR', message: msg });
  }
});

// ── POST /org/slack/disconnect ────────────────────────────────────────────────

router.post('/slack/disconnect', requirePermission('org.manage_settings'), async (_req, res, next) => {
  try {
    await stopSlack();
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── POST /org/slack/test-home ─────────────────────────────────────────────────
// Push the App Home view directly to the requesting user (bypasses events).
// Used to verify the bot token can call views.publish and that the user is linked.

// POST /org/storage/test — round-trip a test object to validate a provider's creds
router.post('/storage/test', requirePermission('org.manage_settings'), async (req, res, next) => {
  try {
    const { provider } = z.object({ provider: z.enum(['gcs', 's3', 'spaces']) }).parse(req.body);
    const [org] = await db.select({ settings: organizations.settings }).from(organizations)
      .where(eq(organizations.id, req.user!.orgId)).limit(1);
    const settings = decryptOrgSettings((org?.settings ?? {}) as OrganizationSettings);
    try {
      const backend = getStorageBackend(settings, provider as StorageProvider);
      await backend.testConnection();
      res.json({ ok: true, detail: `Wrote and deleted a test object in the ${provider.toUpperCase()} bucket.` });
    } catch (err) {
      res.json({ ok: false, detail: err instanceof Error ? err.message : String(err) });
    }
  } catch (err) {
    next(err);
  }
});

router.post('/slack/test-home', requirePermission('org.manage_settings'), async (req, res, next) => {
  try {
    if (!isSlackRunning()) {
      res.status(400).json({ error: 'NOT_CONNECTED', message: 'Slack bot is not running. Click Reconnect first.' });
      return;
    }

    // Find the requesting user's Slack ID
    const [me] = await db
      .select({ slackUserId: users.slackUserId, name: users.name, email: users.email })
      .from(users)
      .where(eq(users.id, req.user!.id))
      .limit(1);

    const { getSlackApp } = await import('../slack/app.js');
    const { appHomeBlocks } = await import('../slack/blocks.js');

    let slackUserId = me?.slackUserId;

    // If not linked yet, look the user up in Slack by email
    if (!slackUserId && me?.email) {
      try {
        const lookup = await getSlackApp().client.users.lookupByEmail({ email: me.email });
        slackUserId = lookup.user?.id ?? null;
        // Auto-link for future calls
        if (slackUserId) {
          await db.update(users).set({ slackUserId }).where(eq(users.id, req.user!.id));
        }
      } catch (_e) {
        // Slack user not found by email — fall through
      }
    }

    if (!slackUserId) {
      res.status(400).json({
        error: 'NO_SLACK_ID',
        message: `Could not find a Slack user matching ${me?.email}. ` +
                 `Make sure the email on your Slack account matches, or send any DM to the bot first.`,
      });
      return;
    }

    await getSlackApp().client.views.publish({
      user_id: slackUserId,
      view: {
        type: 'home',
        blocks: appHomeBlocks([], [], true) as never,
      },
    });

    res.json({ ok: true, message: `Home tab pushed to ${me?.name} (${slackUserId}) — open the App Home tab in Slack to see it.` });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(502).json({ error: 'SLACK_ERROR', message: msg });
  }
});

// ── GET /org/mcp-keys ─────────────────────────────────────────────────────────

router.get('/mcp-keys', requirePermission('org.manage_settings'), async (req, res, next) => {
  try {
    const keys = await db
      .select({
        id: mcpApiKeys.id,
        name: mcpApiKeys.name,
        permissionLevel: mcpApiKeys.permissionLevel,
        projectIds: mcpApiKeys.projectIds,
        createdAt: mcpApiKeys.createdAt,
        lastUsedAt: mcpApiKeys.lastUsedAt,
      })
      .from(mcpApiKeys)
      .where(eq(mcpApiKeys.orgId, req.user!.orgId));

    res.json(keys);
  } catch (err) { next(err); }
});

// ── POST /org/mcp-keys ────────────────────────────────────────────────────────

const createKeySchema = z.object({
  name: z.string().min(1).max(100),
  permissionLevel: z.enum(['read', 'read_write']).default('read'),
  projectIds: z.array(z.string().uuid()).default([]),
});

router.post('/mcp-keys', requirePermission('org.manage_settings'), async (req, res, next) => {
  try {
    const body = createKeySchema.parse(req.body);

    const rawKey = `enlight_${crypto.randomBytes(32).toString('hex')}`;
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');

    const [key] = await db
      .insert(mcpApiKeys)
      .values({
        orgId: req.user!.orgId,
        name: body.name,
        permissionLevel: body.permissionLevel,
        projectIds: body.projectIds,
        keyHash,
      })
      .returning({
        id: mcpApiKeys.id,
        name: mcpApiKeys.name,
        permissionLevel: mcpApiKeys.permissionLevel,
        projectIds: mcpApiKeys.projectIds,
        createdAt: mcpApiKeys.createdAt,
      });

    if (!key) throw Errors.internal();

    // Return raw key ONCE — not stored in plaintext
    res.status(201).json({ ...key, lastUsedAt: null, key: rawKey });
  } catch (err) { next(err); }
});

// ── DELETE /org/mcp-keys/:keyId ───────────────────────────────────────────────

router.delete('/mcp-keys/:keyId', requirePermission('org.manage_settings'), async (req, res, next) => {
  try {
    const [deleted] = await db
      .delete(mcpApiKeys)
      .where(
        and(
          eq(mcpApiKeys.id, req.params['keyId'] as string),
          eq(mcpApiKeys.orgId, req.user!.orgId),
        ),
      )
      .returning({ id: mcpApiKeys.id });

    if (!deleted) { next(Errors.notFound('MCP API Key')); return; }
    res.status(204).send();
  } catch (err) { next(err); }
});

// ── GET /org/slack/usergroups ─────────────────────────────────────────────────
// Returns the list of Slack user groups for the org — used by the project
// access control UI to let admins pick which groups can submit requests to a
// restricted project.  Requires the bot to have the `usergroups:read` scope.

router.get('/slack/usergroups', requirePermission('slack.read_usergroups'), async (_req, res, next) => {
  try {
    const { isSlackRunning, getSlackApp } = await import('../slack/app.js');
    if (!isSlackRunning()) {
      res.status(503).json({ error: 'SLACK_NOT_RUNNING', message: 'Slack integration is not connected.' });
      return;
    }
    const result = await getSlackApp().client.usergroups.list({ include_disabled: false });
    const groups = ((result.usergroups ?? []) as Array<{ id: string; name: string; handle: string }>).map((g) => ({
      id: g.id,
      name: g.name,
      handle: g.handle,
    }));
    res.json(groups);
  } catch (err: unknown) {
    const slackErr = err as { data?: { error?: string } };
    if (slackErr.data?.error === 'missing_scope') {
      res.status(403).json({
        error: 'MISSING_SCOPE',
        message: 'The Slack bot is missing the `usergroups:read` scope. Add it in your Slack App settings and reinstall the app.',
      });
      return;
    }
    next(err);
  }
});

// ── License key ───────────────────────────────────────────────────────────────

// GET /org/license — returns verified license info (never exposes the raw key).
router.get('/license', requirePermission('org.manage_settings'), async (req, res, next) => {
  try {
    const [org] = await db.select({ licenseKey: organizations.licenseKey })
      .from(organizations).where(eq(organizations.id, req.user!.orgId)).limit(1);
    if (!org) { next(Errors.notFound('Organization')); return; }
    const info = verifyLicense(org.licenseKey);
    res.json({ ...info, enforcementEnabled: isLicensingEnabled() });
  } catch (err) { next(err); }
});

// PUT /org/license — store a new license key and return its verified status.
router.put('/license', requirePermission('org.manage_settings'), async (req, res, next) => {
  try {
    const { key } = z.object({ key: z.string().min(1) }).parse(req.body);
    const info = verifyLicense(key.trim());
    if (info.status === 'invalid') {
      res.status(422).json({ error: info.message });
      return;
    }
    await db.update(organizations)
      .set({ licenseKey: key.trim(), updatedAt: new Date() })
      .where(eq(organizations.id, req.user!.orgId));
    clearLicenseCache();
    res.json(info);
  } catch (err) { next(err); }
});

// DELETE /org/license — remove the license key (reverts to unlicensed state).
router.delete('/license', requirePermission('org.manage_settings'), async (req, res, next) => {
  try {
    await db.update(organizations)
      .set({ licenseKey: null, updatedAt: new Date() })
      .where(eq(organizations.id, req.user!.orgId));
    clearLicenseCache();
    res.json({ status: 'unlicensed', message: 'License key removed.' });
  } catch (err) { next(err); }
});

export { router as orgRouter };
