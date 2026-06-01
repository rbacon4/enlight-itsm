/**
 * Microsoft 365 offboarding via Microsoft Graph (client-credentials flow).
 *
 * Mirrors googleWorkspace.ts: every method returns an OffboardingActionResult and
 * never throws, and the service falls back to realistic mock data when no app
 * credentials are configured (or mockMode is on) — so the whole flow runs without
 * a live tenant. Uses raw fetch (no Graph SDK dependency).
 */
import type {
  OrganizationSettings,
  OffboardingActionResult,
  Microsoft365Config,
} from '@enlight/shared';

const GRAPH = 'https://graph.microsoft.com/v1.0';

export interface ResolvedM365Config {
  enabled: boolean;
  tenantId: string;
  clientId: string;
  clientSecret: string;
  transferToManager: boolean;
  mock: boolean;
}

export function resolveMicrosoft365Config(orgSettings?: OrganizationSettings): ResolvedM365Config {
  const cfg: Microsoft365Config = orgSettings?.offboarding?.microsoft ?? {};
  const tenantId = cfg.tenantId || process.env['M365_TENANT_ID'] || '';
  const clientId = cfg.clientId || process.env['M365_CLIENT_ID'] || '';
  const clientSecret = cfg.clientSecret || process.env['M365_CLIENT_SECRET'] || '';
  const envMock = (process.env['MOCK_GOOGLE_API'] ?? '').toLowerCase() === 'true';
  const hasCreds = Boolean(tenantId && clientId && clientSecret);
  return {
    enabled: Boolean(cfg.enabled),
    tenantId,
    clientId,
    clientSecret,
    transferToManager: Boolean(cfg.transferToManager),
    mock: Boolean(cfg.mockMode) || envMock || !hasCreds,
  };
}

export class Microsoft365Service {
  private cfg: ResolvedM365Config;
  private mock: boolean;
  private token: string | null = null;

  constructor(cfg: ResolvedM365Config) {
    this.cfg = cfg;
    this.mock = cfg.mock;
  }

  private async getToken(): Promise<string> {
    if (this.token) return this.token;
    const body = new URLSearchParams({
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    });
    const res = await fetch(`https://login.microsoftonline.com/${this.cfg.tenantId}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) throw new Error(`Token request failed (${res.status})`);
    const json = (await res.json()) as { access_token?: string };
    if (!json.access_token) throw new Error('No access_token in token response.');
    this.token = json.access_token;
    return this.token;
  }

  private async graph(method: string, path: string, body?: unknown): Promise<Response> {
    const token = await this.getToken();
    return fetch(`${GRAPH}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }

  // ── Profile ────────────────────────────────────────────────────────────────

  async getUser(email: string): Promise<{ id: string; displayName?: string; accountEnabled?: boolean } | null> {
    if (this.mock) {
      const name = email.split('@')[0]!.replace(/[._]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
      return { id: 'mock-m365-id', displayName: name, accountEnabled: true };
    }
    const res = await this.graph('GET', `/users/${encodeURIComponent(email)}?$select=id,displayName,accountEnabled`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Graph getUser failed (${res.status})`);
    return (await res.json()) as { id: string; displayName?: string; accountEnabled?: boolean };
  }

  // ── Actions (each returns an OffboardingActionResult, never throws) ──────────

  async disableUser(email: string): Promise<OffboardingActionResult> {
    const action = 'Disable Microsoft 365 sign-in';
    if (this.mock) return { action, success: true, details: `[MOCK] ${email} sign-in disabled.` };
    try {
      const res = await this.graph('PATCH', `/users/${encodeURIComponent(email)}`, { accountEnabled: false });
      if (!res.ok) return { action, success: false, details: '', error: await errText(res) };
      return { action, success: true, details: `${email} sign-in disabled.` };
    } catch (err) {
      return { action, success: false, details: '', error: msg(err) };
    }
  }

  async revokeSessions(email: string): Promise<OffboardingActionResult> {
    const action = 'Revoke Microsoft 365 sessions';
    if (this.mock) return { action, success: true, details: `[MOCK] Sessions revoked for ${email}.` };
    try {
      const res = await this.graph('POST', `/users/${encodeURIComponent(email)}/revokeSignInSessions`);
      if (!res.ok) return { action, success: false, details: '', error: await errText(res) };
      return { action, success: true, details: `Sessions revoked for ${email}.` };
    } catch (err) {
      return { action, success: false, details: '', error: msg(err) };
    }
  }

  async removeLicenses(email: string): Promise<OffboardingActionResult> {
    const action = 'Remove Microsoft 365 licenses';
    if (this.mock) return { action, success: true, details: `[MOCK] All licenses removed from ${email}.` };
    try {
      const licRes = await this.graph('GET', `/users/${encodeURIComponent(email)}/licenseDetails`);
      if (!licRes.ok) return { action, success: false, details: '', error: await errText(licRes) };
      const lic = (await licRes.json()) as { value?: Array<{ skuId: string }> };
      const skuIds = (lic.value ?? []).map((l) => l.skuId);
      if (skuIds.length === 0) return { action, success: true, details: `${email} had no licenses.` };
      const res = await this.graph('POST', `/users/${encodeURIComponent(email)}/assignLicense`, {
        addLicenses: [],
        removeLicenses: skuIds,
      });
      if (!res.ok) return { action, success: false, details: '', error: await errText(res) };
      return { action, success: true, details: `Removed ${skuIds.length} license(s) from ${email}.` };
    } catch (err) {
      return { action, success: false, details: '', error: msg(err) };
    }
  }

  async transferOneDrive(email: string, delegateEmail: string): Promise<OffboardingActionResult> {
    const action = `Grant ${delegateEmail} access to ${email}'s OneDrive`;
    if (this.mock) return { action, success: true, details: `[MOCK] OneDrive of ${email} shared with ${delegateEmail}.` };
    try {
      const res = await this.graph('POST', `/users/${encodeURIComponent(email)}/drive/root/invite`, {
        requireSignIn: true,
        sendInvitation: false,
        roles: ['write'],
        recipients: [{ email: delegateEmail }],
      });
      if (!res.ok) return { action, success: false, details: '', error: await errText(res) };
      return { action, success: true, details: `OneDrive of ${email} shared with ${delegateEmail}.` };
    } catch (err) {
      return { action, success: false, details: '', error: msg(err) };
    }
  }
}

export function makeMicrosoft365Service(orgSettings?: OrganizationSettings): Microsoft365Service {
  return new Microsoft365Service(resolveMicrosoft365Config(orgSettings));
}

async function errText(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as { error?: { message?: string } };
    return j?.error?.message ?? `Graph error ${res.status}`;
  } catch {
    return `Graph error ${res.status}`;
  }
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
