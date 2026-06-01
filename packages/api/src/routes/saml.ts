import { Router } from 'express';
import { SAML } from 'passport-saml';
import { db } from '../db/client.js';
import { users, organizations } from '../db/schema.js';
import { eq, and, isNotNull } from 'drizzle-orm';
import { signToken } from '../middleware/auth.js';
import { fetchIdpMetadata } from '../lib/samlMetadata.js';
import { builtinGlobalRoleId } from '../lib/permissions.js';
import { logger } from '../lib/logger.js';
import type { SamlConfig, OrganizationSettings, GlobalRole } from '@enlight/shared';

function apiUrl() { return (process.env['API_URL'] ?? 'http://localhost:3000').replace(/\/+$/, ''); }
function webUrl() { return (process.env['WEB_URL'] ?? 'http://localhost:5173').replace(/\/+$/, ''); }

function spEntityId(orgId: string) { return `${apiUrl()}/saml/${orgId}/metadata`; }
function spAcsUrl(orgId: string)   { return `${apiUrl()}/auth/saml/${orgId}/acs`; }

interface OrgSamlContext {
  orgId: string;
  saml: SAML;
  samlConfig: SamlConfig;
  settings: OrganizationSettings;
}

/** Loads the org, fetches its IdP metadata, and builds a configured SAML instance. */
async function buildSamlForOrg(orgId: string): Promise<OrgSamlContext> {
  const [org] = await db
    .select({
      id: organizations.id,
      samlConfig: organizations.samlConfig,
      settings: organizations.settings,
    })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  if (!org) throw new Error('Organization not found.');

  const samlConfig = (org.samlConfig ?? null) as SamlConfig | null;
  if (!samlConfig?.idpMetadataUrl) {
    throw new Error('SAML SSO is not configured for this organization.');
  }

  const meta = await fetchIdpMetadata(samlConfig.idpMetadataUrl);
  if (!meta.ok || !meta.entryPoint) {
    throw new Error(meta.error ?? 'Could not load Identity Provider metadata.');
  }
  if (!meta.certs || meta.certs.length === 0) {
    throw new Error('Identity Provider metadata has no signing certificate.');
  }

  const saml = new SAML({
    entryPoint: meta.entryPoint,
    issuer: spEntityId(orgId),
    callbackUrl: spAcsUrl(orgId),
    cert: meta.certs,
    identifierFormat: null,
    // Stateless: we don't persist generated request IDs, so don't enforce InResponseTo.
    validateInResponseTo: false,
    wantAssertionsSigned: true,
    acceptedClockSkewMs: 5000,
  });

  return { orgId, saml, samlConfig, settings: (org.settings ?? {}) as OrganizationSettings };
}

/** Pulls the user's email out of a SAML profile using the org's attribute mapping. */
function emailFromProfile(profile: Record<string, unknown>, samlConfig: SamlConfig): string | undefined {
  const mapped = samlConfig.emailAttribute ? profile[samlConfig.emailAttribute] : undefined;
  const candidates = [
    mapped,
    profile['email'],
    profile['mail'],
    profile['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress'],
    profile['nameID'],
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.includes('@')) return c.trim().toLowerCase();
  }
  return undefined;
}

/** Builds a display name from the profile's first/last name attributes, falling back to email. */
function nameFromProfile(profile: Record<string, unknown>, samlConfig: SamlConfig, email: string): string {
  const first = samlConfig.firstNameAttribute ? profile[samlConfig.firstNameAttribute] : undefined;
  const last  = samlConfig.lastNameAttribute  ? profile[samlConfig.lastNameAttribute]  : undefined;
  const parts = [first, last].filter((p): p is string => typeof p === 'string' && p.trim().length > 0);
  if (parts.length > 0) return parts.join(' ');
  const display = profile['displayName'] ?? profile['cn'];
  if (typeof display === 'string' && display.trim()) return display.trim();
  return email.split('@')[0] ?? email;
}

/** Reads a single string attribute from a SAML profile by its mapped name. */
function attr(profile: Record<string, unknown>, name: string | undefined): string | undefined {
  if (!name) return undefined;
  const v = profile[name];
  if (typeof v === 'string' && v.trim()) return v.trim();
  if (Array.isArray(v) && typeof v[0] === 'string') return (v[0] as string).trim() || undefined;
  return undefined;
}

/** Resolves a manager reference from SAML (usually an email) to a local user id. */
async function resolveSamlManager(ref: string | undefined, orgId: string): Promise<string | null> {
  const r = (ref ?? '').trim();
  if (!r) return null;
  const col = r.includes('@') ? users.email : users.externalId;
  const [u] = await db.select({ id: users.id }).from(users)
    .where(and(eq(users.orgId, orgId), eq(col, r.includes('@') ? r.toLowerCase() : r))).limit(1);
  return u?.id ?? null;
}

/** Builds the profile fields to sync from a SAML assertion, per the org's attribute mapping. */
async function profileFromSaml(profile: Record<string, unknown>, samlConfig: SamlConfig, orgId: string): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const dept = attr(profile, samlConfig.departmentAttribute);
  const title = attr(profile, samlConfig.jobTitleAttribute);
  const city = attr(profile, samlConfig.cityAttribute);
  const state = attr(profile, samlConfig.stateAttribute);
  const country = attr(profile, samlConfig.countryAttribute);
  const managerRef = attr(profile, samlConfig.managerAttribute);
  if (dept !== undefined) out['department'] = dept;
  if (title !== undefined) out['jobTitle'] = title;
  if (city !== undefined) out['city'] = city;
  if (state !== undefined) out['state'] = state;
  if (country !== undefined) out['country'] = country;
  if (managerRef !== undefined) out['managerId'] = await resolveSamlManager(managerRef, orgId);
  return out;
}

function ssoErrorRedirect(res: import('express').Response, message: string): void {
  const params = new URLSearchParams({ sso_error: message });
  res.redirect(`${webUrl()}/login?${params.toString()}`);
}

// ── /auth/saml router (mounted at /auth/saml) ─────────────────────────────────

const authRouter = Router();

// GET /auth/saml/login — convenience entry point. Resolves the org when a single
// SAML-enabled org exists; otherwise requires /auth/saml/:orgId/login.
authRouter.get('/login', async (req, res) => {
  try {
    const orgs = await db
      .select({ id: organizations.id, samlConfig: organizations.samlConfig })
      .from(organizations)
      .where(isNotNull(organizations.samlConfig));

    const enabled = orgs.filter((o) => (o.samlConfig as SamlConfig | null)?.idpMetadataUrl);
    if (enabled.length === 0) { ssoErrorRedirect(res, 'SAML SSO is not configured.'); return; }
    if (enabled.length > 1) { ssoErrorRedirect(res, 'Multiple SSO organizations exist — use your organization-specific login URL.'); return; }

    res.redirect(`${apiUrl()}/auth/saml/${enabled[0]!.id}/login`);
  } catch (err) {
    logger.error('SAML login resolve failed', { err });
    ssoErrorRedirect(res, 'Could not start SSO login.');
  }
});

// GET /auth/saml/:orgId/login — SP-initiated: redirect the browser to the IdP.
authRouter.get('/:orgId/login', async (req, res) => {
  const orgId = req.params['orgId'] as string;
  try {
    const { saml } = await buildSamlForOrg(orgId);
    const relayState = typeof req.query['returnTo'] === 'string' ? req.query['returnTo'] : '';
    const url = await saml.getAuthorizeUrlAsync(relayState, undefined, {});
    res.redirect(url);
  } catch (err) {
    logger.error('SAML login init failed', { orgId, err });
    ssoErrorRedirect(res, err instanceof Error ? err.message : 'Could not start SSO login.');
  }
});

// POST /auth/saml/:orgId/acs — Assertion Consumer Service: consume the IdP response.
authRouter.post('/:orgId/acs', async (req, res) => {
  const orgId = req.params['orgId'] as string;
  try {
    const { saml, samlConfig, settings } = await buildSamlForOrg(orgId);

    const { profile, loggedOut } = await saml.validatePostResponseAsync(req.body);
    if (loggedOut || !profile) { ssoErrorRedirect(res, 'No SAML assertion received.'); return; }

    const p = profile as unknown as Record<string, unknown>;
    const email = emailFromProfile(p, samlConfig);
    if (!email) { ssoErrorRedirect(res, 'SAML assertion did not include an email address.'); return; }

    const nameId = typeof p['nameID'] === 'string' ? (p['nameID'] as string) : email;

    // Find an existing user in this org by email.
    let [user] = await db
      .select()
      .from(users)
      .where(and(eq(users.orgId, orgId), eq(users.email, email)))
      .limit(1);

    // Auto-provision when the email domain is approved and a default role is set.
    if (!user) {
      const domain = email.split('@')[1] ?? '';
      const approved = (settings.approvedDomains ?? []).map((d) => d.toLowerCase());
      const role = settings.autoProvisionRole as GlobalRole | undefined;
      if (!role || !approved.includes(domain)) {
        ssoErrorRedirect(res, 'No account exists for this user and auto-provisioning is not enabled for this domain.');
        return;
      }
      [user] = await db
        .insert(users)
        .values({
          orgId,
          email,
          name: nameFromProfile(p, samlConfig, email),
          globalRole: role,
          roleId: await builtinGlobalRoleId(orgId, role),
          samlNameId: nameId,
          ...(await profileFromSaml(p, samlConfig, orgId)),
        })
        .returning();
    } else {
      if (!user.active) {
        ssoErrorRedirect(res, 'This account has been deactivated.');
        return;
      }
      // Refresh NameID + profile fields from the IdP on each login (IdP is source of truth).
      await db.update(users).set({
        samlNameId: nameId,
        ...(await profileFromSaml(p, samlConfig, orgId)),
        updatedAt: new Date(),
      }).where(eq(users.id, user.id));
    }

    if (!user) { ssoErrorRedirect(res, 'Could not provision user.'); return; }

    const token = signToken({
      id: user.id,
      orgId: user.orgId,
      email: user.email,
      name: user.name,
      globalRole: user.globalRole,
    });

    // Hand the token to the SPA via the URL fragment (kept out of server logs / referrers).
    res.redirect(`${webUrl()}/auth/callback#token=${encodeURIComponent(token)}`);
  } catch (err) {
    logger.error('SAML ACS failed', { orgId, err });
    ssoErrorRedirect(res, err instanceof Error ? err.message : 'SSO authentication failed.');
  }
});

// ── /saml router (mounted at /saml) ───────────────────────────────────────────

const metadataRouter = Router();

// GET /saml/:orgId/metadata — Service Provider metadata XML for the IdP to import.
metadataRouter.get('/:orgId/metadata', (req, res) => {
  const orgId = req.params['orgId'] as string;
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${spEntityId(orgId)}">
  <SPSSODescriptor AuthnRequestsSigned="false" WantAssertionsSigned="true" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</NameIDFormat>
    <AssertionConsumerService index="0" isDefault="true" Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${spAcsUrl(orgId)}"/>
  </SPSSODescriptor>
</EntityDescriptor>`;
  res.setHeader('Content-Type', 'application/samlmetadata+xml');
  res.send(xml);
});

export { authRouter as samlAuthRouter, metadataRouter as samlMetadataRouter };
