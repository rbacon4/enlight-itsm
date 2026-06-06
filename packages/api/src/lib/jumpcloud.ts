/**
 * JumpCloud integration.
 *
 * Supports dual auth: API key (x-api-key header) AND service account
 * (OAuth 2.0 client credentials). Token expiry treated as valid for max 50 minutes.
 * Falls back to mock mode when no credentials are configured.
 *
 * No new npm dependencies — uses fetch for all HTTP.
 */
import type { OrganizationSettings, JumpCloudUser, JumpCloudSystem, JumpCloudUserPage, JumpCloudAuthMode } from '@enlight/shared';
import { encryptSecret, decryptSecret } from './secretCrypto.js';
import { db } from '../db/client.js';
import { organizations } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { logger } from './logger.js';

const V1_BASE = 'https://console.jumpcloud.com/api';
const V2_BASE = 'https://console.jumpcloud.com/api/v2';
const TOKEN_URL = 'https://admin-oauth.id.jumpcloud.com/oauth2/token';

export interface JumpCloudOffboardingResult {
  suspended: boolean;
  groupsRemoved: number;
  systemsUnbound: number;
  mock: boolean;
  error?: string;
}

function isMockMode(settings?: OrganizationSettings): boolean {
  if ((process.env['MOCK_JUMPCLOUD_API'] ?? '').toLowerCase() === 'true') return true;
  const jc = settings?.jumpcloud;
  if (!jc) return true;
  const mode = jc.authMode ?? 'apiKey';
  if (mode === 'apiKey' && !jc.apiKey) return true;
  if (mode === 'serviceAccount' && (!jc.clientId || !jc.clientSecret)) return true;
  return false;
}

interface CachedToken {
  token: string;
  expiresAt: number; // epoch ms
}

export class JumpCloudClient {
  private mock: boolean;
  private authMode: JumpCloudAuthMode;
  private apiKey: string;
  private clientId: string;
  private clientSecret: string;
  private cachedToken: CachedToken | null = null;

  constructor(private settings?: OrganizationSettings, private orgId?: string) {
    this.mock = isMockMode(settings);
    const jc = settings?.jumpcloud ?? {};
    this.authMode = jc.authMode ?? 'apiKey';
    this.apiKey = jc.apiKey ?? process.env['JUMPCLOUD_API_KEY'] ?? '';
    this.clientId = jc.clientId ?? process.env['JUMPCLOUD_CLIENT_ID'] ?? '';
    this.clientSecret = jc.clientSecret ?? process.env['JUMPCLOUD_CLIENT_SECRET'] ?? '';

    // Restore cached token from settings if still valid (>5min remaining)
    if (jc.cachedAccessToken && jc.tokenExpiresAt) {
      const exp = new Date(jc.tokenExpiresAt).getTime();
      if (exp - Date.now() > 5 * 60 * 1000) {
        this.cachedToken = { token: decryptSecret(jc.cachedAccessToken), expiresAt: exp };
      }
    }
  }

  private async getAuthHeaders(): Promise<Record<string, string>> {
    if (this.authMode === 'apiKey') {
      return { 'x-api-key': this.apiKey };
    }
    // service account: fetch or refresh token
    const now = Date.now();
    if (this.cachedToken && this.cachedToken.expiresAt - now > 5 * 60 * 1000) {
      return { Authorization: `Bearer ${this.cachedToken.token}` };
    }
    const creds = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${creds}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'openid' }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`JumpCloud token request failed (${res.status})`);
    const j = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!j.access_token) throw new Error('No access_token in JumpCloud token response');

    // max 50 minutes to be safe
    const expiresIn = Math.min(j.expires_in ?? 3600, 50 * 60);
    const expiresAt = now + expiresIn * 1000;
    this.cachedToken = { token: j.access_token, expiresAt };

    // Persist encrypted token back to org settings
    if (this.orgId) {
      try {
        const enc = encryptSecret(j.access_token);
        const [existing] = await db.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, this.orgId)).limit(1);
        const current = (existing?.settings ?? {}) as Record<string, unknown>;
        const jcSettings = { ...(current['jumpcloud'] as Record<string, unknown> ?? {}), cachedAccessToken: enc, tokenExpiresAt: new Date(expiresAt).toISOString() };
        await db.update(organizations).set({ settings: { ...current, jumpcloud: jcSettings }, updatedAt: new Date() }).where(eq(organizations.id, this.orgId));
      } catch (err) {
        logger.warn('JumpCloud: failed to persist cached token', { err });
      }
    }

    return { Authorization: `Bearer ${j.access_token}` };
  }

  /** Exponential backoff on 429. */
  private async fetchV1(method: string, path: string, body?: unknown): Promise<Response> {
    return this.fetchWithRetry(`${V1_BASE}${path}`, method, body);
  }
  private async fetchV2(method: string, path: string, body?: unknown): Promise<Response> {
    return this.fetchWithRetry(`${V2_BASE}${path}`, method, body);
  }

  private async fetchWithRetry(url: string, method: string, body?: unknown): Promise<Response> {
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
        if (res.status === 429 && attempt < 3) {
          await sleep(delays[attempt] ?? 4000);
          continue;
        }
        return res;
      } catch (err) {
        lastErr = err;
        if (attempt < 3) await sleep(delays[attempt] ?? 4000);
      }
    }
    throw lastErr ?? new Error('JumpCloud fetch failed after retries');
  }

  async listUsers(opts?: { skip?: number; limit?: number }): Promise<JumpCloudUserPage> {
    if (this.mock) {
      return {
        results: [
          { id: 'jc-mock-001', username: 'jane.smith', email: 'jane.smith@example.com', firstname: 'Jane', lastname: 'Smith', department: 'Engineering', jobTitle: 'Software Engineer', suspended: false, activated: true },
          { id: 'jc-mock-002', username: 'bob.jones', email: 'bob.jones@example.com', firstname: 'Bob', lastname: 'Jones', department: 'Sales', jobTitle: 'Account Executive', suspended: false, activated: true },
        ],
        totalCount: 2,
        skip: 0,
        limit: 10,
      };
    }
    const params = new URLSearchParams({ limit: String(opts?.limit ?? 100), skip: String(opts?.skip ?? 0) });
    const res = await this.fetchV1('GET', `/systemusers?${params}`);
    if (!res.ok) throw new Error(`JumpCloud listUsers failed (${res.status})`);
    return (await res.json()) as JumpCloudUserPage;
  }

  async getUser(id: string): Promise<JumpCloudUser | null> {
    if (this.mock) {
      return { id, username: 'mock.user', email: `user-${id}@example.com`, suspended: false, activated: true };
    }
    const res = await this.fetchV1('GET', `/systemusers/${id}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`JumpCloud getUser failed (${res.status})`);
    return (await res.json()) as JumpCloudUser;
  }

  async suspendUser(id: string): Promise<boolean> {
    if (this.mock) {
      logger.info('[MOCK] JumpCloud: suspended user', { id });
      return true;
    }
    const res = await this.fetchV1('PUT', `/systemusers/${id}`, { suspended: true });
    if (!res.ok) {
      logger.warn('JumpCloud suspendUser failed', { id, status: res.status });
      return false;
    }
    return true;
  }

  async listUserGroups(userId: string): Promise<Array<{ id: string; displayName?: string }>> {
    if (this.mock) {
      return [{ id: 'grp-mock-001', displayName: 'Engineering' }, { id: 'grp-mock-002', displayName: 'All Employees' }];
    }
    const res = await this.fetchV2('GET', `/users/${userId}/memberof?limit=100`);
    if (!res.ok) {
      logger.warn('JumpCloud listUserGroups failed', { userId, status: res.status });
      return [];
    }
    const data = (await res.json()) as Array<{ id?: string; displayName?: string }>;
    return data.map(g => ({ id: g.id ?? '', ...(g.displayName !== undefined ? { displayName: g.displayName } : {}) }));
  }

  async removeUserFromGroup(userId: string, groupId: string): Promise<boolean> {
    if (this.mock) {
      logger.info('[MOCK] JumpCloud: removed user from group', { userId, groupId });
      return true;
    }
    const res = await this.fetchV2('POST', `/usergroups/${groupId}/members`, {
      op: 'remove', type: 'user', id: userId,
    });
    if (!res.ok) {
      logger.warn('JumpCloud removeUserFromGroup failed', { userId, groupId, status: res.status });
      return false;
    }
    return true;
  }

  async listUserSystems(userId: string): Promise<JumpCloudSystem[]> {
    if (this.mock) {
      return [{ id: 'sys-mock-001', displayName: 'MacBook Pro', hostname: 'MBPRO-001', os: 'macOS', active: true }];
    }
    const res = await this.fetchV2('GET', `/users/${userId}/systems?limit=100`);
    if (!res.ok) {
      logger.warn('JumpCloud listUserSystems failed', { userId, status: res.status });
      return [];
    }
    return (await res.json()) as JumpCloudSystem[];
  }

  async unbindUserFromSystem(userId: string, systemId: string): Promise<boolean> {
    if (this.mock) {
      logger.info('[MOCK] JumpCloud: unbound user from system', { userId, systemId });
      return true;
    }
    const res = await this.fetchV2('POST', `/systems/${systemId}/associations`, {
      op: 'remove', type: 'user', id: userId,
    });
    if (!res.ok) {
      logger.warn('JumpCloud unbindUserFromSystem failed', { userId, systemId, status: res.status });
      return false;
    }
    return true;
  }

  async testConnection(): Promise<{ ok: boolean; userCount?: number; error?: string }> {
    if (this.mock) {
      return { ok: true, userCount: 2 };
    }
    try {
      const page = await this.listUsers({ limit: 1 });
      return { ok: true, userCount: page.totalCount };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Run offboarding for a departing employee. */
  async offboardByEmail(email: string, unbindSystems: boolean): Promise<JumpCloudOffboardingResult> {
    const result: JumpCloudOffboardingResult = {
      suspended: false, groupsRemoved: 0, systemsUnbound: 0, mock: this.mock,
    };
    try {
      // Find user by email
      let userId: string | null = null;
      if (this.mock) {
        userId = `jc-mock-${email}`;
      } else {
        const page = await this.listUsers();
        const found = page.results.find(u => u.email.toLowerCase() === email.toLowerCase());
        if (!found) {
          result.error = `User with email ${email} not found in JumpCloud`;
          return result;
        }
        userId = found.id;
      }

      result.suspended = await this.suspendUser(userId);

      const groups = await this.listUserGroups(userId);
      for (const g of groups) {
        const ok = await this.removeUserFromGroup(userId, g.id);
        if (ok) result.groupsRemoved++;
      }

      if (unbindSystems) {
        const systems = await this.listUserSystems(userId);
        for (const s of systems) {
          const ok = await this.unbindUserFromSystem(userId, s.id);
          if (ok) result.systemsUnbound++;
        }
      }
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
      logger.error('JumpCloud offboarding error', { email, err });
    }
    return result;
  }
}

export function makeJumpCloudClient(settings?: OrganizationSettings, orgId?: string): JumpCloudClient {
  return new JumpCloudClient(settings, orgId);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
