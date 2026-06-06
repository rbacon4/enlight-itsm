/**
 * Okta integration.
 *
 * Supports dual auth: SSWS API token (Authorization: SSWS <token>) AND OAuth 2.0
 * service app with private key JWT assertion. Pagination follows Link header
 * rel="next" cursor. Falls back to mock mode when no credentials are configured.
 *
 * JWT signing: jsonwebtoken is NOT in the dependency tree. Uses Web Crypto API
 * (crypto.subtle) for RS256/ES256 signing of the client assertion.
 *
 * No new npm dependencies — uses fetch for all HTTP.
 */
import crypto from 'node:crypto';
import type { OrganizationSettings, OktaUser, OktaGroup, OktaUserPage, OktaAuthMode } from '@enlight/shared';
import { encryptSecret, decryptSecret } from './secretCrypto.js';
import { db } from '../db/client.js';
import { organizations } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { logger } from './logger.js';

export interface OktaOffboardingResult {
  deactivated: boolean;
  sessionRevoked: boolean;
  groupsRemoved: number;
  previousStatus: string;
  mock: boolean;
  error?: string;
}

function isMockMode(settings?: OrganizationSettings): boolean {
  if ((process.env['MOCK_OKTA_API'] ?? '').toLowerCase() === 'true') return true;
  const o = settings?.okta;
  if (!o?.domain) return true;
  const mode = o.authMode ?? 'ssws';
  if (mode === 'ssws' && !o.apiToken) return true;
  if (mode === 'oauth' && (!o.clientId || !o.privateKeyJwk)) return true;
  return false;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

/** Base64url encode without padding. */
function b64url(buf: Buffer | Uint8Array): string {
  return Buffer.from(buf).toString('base64url');
}

/**
 * Build and sign a JWT client assertion using Web Crypto (crypto.subtle).
 * Supports RS256 (RSA) and ES256 (EC) private keys in JWK format.
 */
async function buildClientAssertion(clientId: string, domain: string, privateKeyJwk: string): Promise<string> {
  let jwk: Record<string, unknown>;
  try {
    jwk = JSON.parse(privateKeyJwk) as Record<string, unknown>;
  } catch {
    throw new Error('Okta privateKeyJwk is not valid JSON');
  }

  const kty = String(jwk['kty'] ?? '').toUpperCase();
  const alg = kty === 'EC' ? 'ES256' : 'RS256';

  // Import the private key. The JsonWebKey/CryptoKey types live in the DOM lib
  // which we don't include, so we cast through unknown.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const importKeyFn = crypto.subtle.importKey.bind(crypto.subtle) as (...args: any[]) => Promise<unknown>;
  const cryptoKey = await importKeyFn(
    'jwk',
    jwk,
    kty === 'EC'
      ? { name: 'ECDSA', namedCurve: 'P-256' }
      : { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const header = { alg, typ: 'JWT', ...(jwk['kid'] ? { kid: String(jwk['kid']) } : {}) };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: clientId,
    sub: clientId,
    aud: `https://${domain}/oauth2/v1/token`,
    iat: now,
    exp: now + 300, // 5 min
    jti: crypto.randomUUID(),
  };

  const headerB64 = b64url(Buffer.from(JSON.stringify(header)));
  const payloadB64 = b64url(Buffer.from(JSON.stringify(payload)));
  const sigInput = `${headerB64}.${payloadB64}`;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const signFn = crypto.subtle.sign.bind(crypto.subtle) as (...args: any[]) => Promise<ArrayBuffer>;
  const sigBuf = await signFn(
    kty === 'EC' ? { name: 'ECDSA', hash: 'SHA-256' } : { name: 'RSASSA-PKCS1-v1_5' },
    cryptoKey,
    new TextEncoder().encode(sigInput),
  );

  return `${sigInput}.${b64url(new Uint8Array(sigBuf))}`;
}

export class OktaClient {
  private mock: boolean;
  private domain: string;
  private authMode: OktaAuthMode;
  private apiToken: string;
  private clientId: string;
  private privateKeyJwk: string;
  private cachedToken: CachedToken | null = null;

  constructor(private settings?: OrganizationSettings, private orgId?: string) {
    this.mock = isMockMode(settings);
    const o = settings?.okta ?? {};
    this.domain = o.domain ?? process.env['OKTA_DOMAIN'] ?? '';
    this.authMode = o.authMode ?? 'ssws';
    this.apiToken = o.apiToken ?? process.env['OKTA_API_TOKEN'] ?? '';
    this.clientId = o.clientId ?? process.env['OKTA_CLIENT_ID'] ?? '';
    this.privateKeyJwk = o.privateKeyJwk ?? process.env['OKTA_PRIVATE_KEY_JWK'] ?? '';

    // Restore cached token from settings if still valid
    if (o.cachedAccessToken && o.tokenExpiresAt) {
      const exp = new Date(o.tokenExpiresAt).getTime();
      if (exp - Date.now() > 5 * 60 * 1000) {
        this.cachedToken = { token: decryptSecret(o.cachedAccessToken), expiresAt: exp };
      }
    }
  }

  private get baseUrl(): string {
    return `https://${this.domain}/api/v1`;
  }

  private async getAuthHeaders(): Promise<Record<string, string>> {
    if (this.authMode === 'ssws') {
      return { Authorization: `SSWS ${this.apiToken}` };
    }
    // OAuth: build JWT, exchange for access token
    const now = Date.now();
    if (this.cachedToken && this.cachedToken.expiresAt - now > 5 * 60 * 1000) {
      return { Authorization: `Bearer ${this.cachedToken.token}` };
    }

    const assertion = await buildClientAssertion(this.clientId, this.domain, this.privateKeyJwk);
    const tokenUrl = `https://${this.domain}/oauth2/v1/token`;
    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        scope: 'okta.users.manage okta.groups.manage',
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: assertion,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Okta token request failed (${res.status})`);
    const j = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!j.access_token) throw new Error('No access_token in Okta token response');

    const expiresIn = Math.min(j.expires_in ?? 3600, 50 * 60);
    const expiresAt = now + expiresIn * 1000;
    this.cachedToken = { token: j.access_token, expiresAt };

    if (this.orgId) {
      try {
        const enc = encryptSecret(j.access_token);
        const [existing] = await db.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, this.orgId)).limit(1);
        const current = (existing?.settings ?? {}) as Record<string, unknown>;
        const oktaSettings = { ...(current['okta'] as Record<string, unknown> ?? {}), cachedAccessToken: enc, tokenExpiresAt: new Date(expiresAt).toISOString() };
        await db.update(organizations).set({ settings: { ...current, okta: oktaSettings }, updatedAt: new Date() }).where(eq(organizations.id, this.orgId));
      } catch (err) {
        logger.warn('Okta: failed to persist cached token', { err });
      }
    }

    return { Authorization: `Bearer ${j.access_token}` };
  }

  /** Follow Link rel="next" headers to paginate through all results. */
  private async paginate<T>(url: string, headers: Record<string, string>): Promise<T[]> {
    const results: T[] = [];
    let next: string | null = url;
    while (next) {
      const res = await fetch(next, { headers, signal: AbortSignal.timeout(15_000) });
      if (res.status === 429) {
        const reset = res.headers.get('X-Rate-Limit-Reset');
        const waitMs = reset ? Math.max(0, parseInt(reset, 10) * 1000 - Date.now()) : 2000;
        await sleep(Math.min(waitMs, 30_000));
        continue;
      }
      if (!res.ok) throw new Error(`Okta paginate failed (${res.status}) at ${next}`);
      const page = (await res.json()) as T[];
      results.push(...page);
      // Parse Link header
      next = null;
      const link = res.headers.get('link') ?? '';
      const match = link.match(/<([^>]+)>;\s*rel="next"/);
      if (match?.[1]) next = match[1];
    }
    return results;
  }

  /** Fetch with 429 backoff using X-Rate-Limit-Reset header when present. */
  private async fetchOkta(method: string, path: string, body?: unknown): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const delays = [1000, 2000, 4000];
    let lastErr: unknown;
    for (let attempt = 0; attempt <= 3; attempt++) {
      try {
        const authHeaders = await this.getAuthHeaders();
        const res = await fetch(url, {
          method,
          headers: { ...authHeaders, 'Content-Type': 'application/json', Accept: 'application/json' },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(15_000),
        });
        if (res.status === 429) {
          const reset = res.headers.get('X-Rate-Limit-Reset');
          const waitMs = reset ? Math.max(0, parseInt(reset, 10) * 1000 - Date.now()) : (delays[attempt] ?? 4000);
          await sleep(Math.min(waitMs, 30_000));
          continue;
        }
        return res;
      } catch (err) {
        lastErr = err;
        if (attempt < 3) await sleep(delays[attempt] ?? 4000);
      }
    }
    throw lastErr ?? new Error('Okta fetch failed after retries');
  }

  async listUsers(opts?: { filter?: string; limit?: number }): Promise<OktaUserPage> {
    if (this.mock) {
      return {
        users: [
          { id: 'okta-mock-001', status: 'ACTIVE', profile: { login: 'jane.smith@example.com', email: 'jane.smith@example.com', firstName: 'Jane', lastName: 'Smith', department: 'Engineering', title: 'Software Engineer' } },
          { id: 'okta-mock-002', status: 'ACTIVE', profile: { login: 'bob.jones@example.com', email: 'bob.jones@example.com', firstName: 'Bob', lastName: 'Jones', department: 'Sales', title: 'Account Executive' } },
        ],
      };
    }
    const params = new URLSearchParams({ limit: String(opts?.limit ?? 200) });
    if (opts?.filter) params.set('filter', opts.filter);
    const authHeaders = await this.getAuthHeaders();
    const url = `${this.baseUrl}/users?${params}`;
    const users = await this.paginate<OktaUser>(url, { ...authHeaders, Accept: 'application/json' });
    return { users };
  }

  async getUser(idOrLogin: string): Promise<OktaUser | null> {
    if (this.mock) {
      return { id: idOrLogin, status: 'ACTIVE', profile: { login: `${idOrLogin}@example.com`, email: `${idOrLogin}@example.com` } };
    }
    const res = await this.fetchOkta('GET', `/users/${encodeURIComponent(idOrLogin)}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Okta getUser failed (${res.status})`);
    return (await res.json()) as OktaUser;
  }

  async deactivateUser(userId: string): Promise<boolean> {
    if (this.mock) {
      logger.info('[MOCK] Okta: deactivated user', { userId });
      return true;
    }
    const res = await this.fetchOkta('POST', `/users/${userId}/lifecycle/deactivate`);
    if (!res.ok) {
      logger.warn('Okta deactivateUser failed', { userId, status: res.status });
      return false;
    }
    return true;
  }

  async revokeUserSessions(userId: string): Promise<boolean> {
    if (this.mock) {
      logger.info('[MOCK] Okta: revoked sessions', { userId });
      return true;
    }
    const res = await this.fetchOkta('DELETE', `/users/${userId}/sessions`);
    if (!res.ok) {
      logger.warn('Okta revokeUserSessions failed', { userId, status: res.status });
      return false;
    }
    return true;
  }

  async listUserGroups(userId: string): Promise<OktaGroup[]> {
    if (this.mock) {
      return [
        { id: 'grp-mock-001', profile: { name: 'Engineering', description: 'Engineering team' } },
        { id: 'grp-mock-everyone', profile: { name: 'Everyone', description: 'All users' } },
      ];
    }
    const authHeaders = await this.getAuthHeaders();
    const url = `${this.baseUrl}/users/${userId}/groups`;
    return this.paginate<OktaGroup>(url, { ...authHeaders, Accept: 'application/json' });
  }

  async removeUserFromGroup(groupId: string, userId: string): Promise<boolean> {
    if (this.mock) {
      logger.info('[MOCK] Okta: removed user from group', { userId, groupId });
      return true;
    }
    const res = await this.fetchOkta('DELETE', `/groups/${groupId}/users/${userId}`);
    if (!res.ok) {
      logger.warn('Okta removeUserFromGroup failed', { userId, groupId, status: res.status });
      return false;
    }
    return true;
  }

  async testConnection(): Promise<{ ok: boolean; orgName?: string; error?: string }> {
    if (this.mock) {
      return { ok: true, orgName: 'Mock Okta Org' };
    }
    try {
      const res = await this.fetchOkta('GET', '/../api/v1/org');
      if (!res.ok) throw new Error(`Okta org endpoint failed (${res.status})`);
      const org = (await res.json()) as { name?: string; companyName?: string };
      return { ok: true, orgName: org.companyName ?? org.name ?? 'Unknown' };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Run offboarding for a departing employee (lookup by email/login). */
  async offboardByEmail(email: string, revokeSessions: boolean, removeGroups: boolean): Promise<OktaOffboardingResult> {
    const result: OktaOffboardingResult = {
      deactivated: false, sessionRevoked: false, groupsRemoved: 0,
      previousStatus: 'UNKNOWN', mock: this.mock,
    };
    try {
      let user: OktaUser | null = null;
      if (this.mock) {
        user = { id: `okta-mock-${email}`, status: 'ACTIVE', profile: { login: email, email } };
      } else {
        user = await this.getUser(email);
      }
      if (!user) {
        result.error = `User with email/login ${email} not found in Okta`;
        return result;
      }
      result.previousStatus = user.status;

      if (user.status === 'DEPROVISIONED') {
        result.error = `User is already DEPROVISIONED`;
        result.deactivated = true;
        return result;
      }

      if (revokeSessions) {
        result.sessionRevoked = await this.revokeUserSessions(user.id);
      }

      if (removeGroups) {
        const groups = await this.listUserGroups(user.id);
        for (const g of groups) {
          if (g.profile.name === 'Everyone') continue; // skip built-in group
          const ok = await this.removeUserFromGroup(g.id, user.id);
          if (ok) result.groupsRemoved++;
        }
      }

      result.deactivated = await this.deactivateUser(user.id);
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
      logger.error('Okta offboarding error', { email, err });
    }
    return result;
  }
}

export function makeOktaClient(settings?: OrganizationSettings, orgId?: string): OktaClient {
  return new OktaClient(settings, orgId);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
