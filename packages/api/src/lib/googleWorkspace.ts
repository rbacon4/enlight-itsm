/**
 * Google Workspace Admin SDK wrapper for the offboarding workflow.
 *
 * Ported from the standalone Python offboarding app (services/google_admin.py).
 * Handles: suspend account, move to an OU, transfer Drive files, profile lookup.
 *
 * Uses a service account with domain-wide delegation (impersonating a super
 * admin). When no service-account credentials are configured — or mockMode is
 * on — every method returns realistic mock data so the whole feature runs
 * end-to-end without a live Workspace environment.
 */
import { google, type admin_directory_v1, type admin_datatransfer_v1 } from 'googleapis';
import type {
  OrganizationSettings,
  OffboardingActionResult,
  OffboardingProfileLookup,
} from '@enlight/shared';
import { logger } from './logger.js';

const SCOPES = [
  'https://www.googleapis.com/auth/admin.directory.user',
  'https://www.googleapis.com/auth/admin.directory.orgunit',
  'https://www.googleapis.com/auth/admin.datatransfer',
];

const DEFAULT_DEPARTED_OU = '/Departed Employees';

export interface ResolvedOffboardingConfig {
  enabled?: boolean;
  googleAdminEmail: string;
  googleDomain: string;
  /** Shared GCP service-account JSON (from settings.gcp). */
  serviceAccountJson: string;
  /** Shared GCP project ID (from settings.gcp). */
  gcpProjectId: string;
  departedOuPath: string;
  archiveOuPath?: string;
  auditChannel?: string;
  trackingProjectId?: string;
  mockMode?: boolean;
  /** True when the service should return mock data instead of calling Google. */
  mock: boolean;
}

/**
 * Merge org settings (already decrypted) with environment fallbacks and decide
 * whether to run in mock mode. Mock mode kicks in when there is no usable
 * service-account JSON / admin email, or when mockMode is explicitly set.
 */
export function resolveOffboardingConfig(orgSettings?: OrganizationSettings): ResolvedOffboardingConfig {
  const cfg = orgSettings?.offboarding ?? {};
  const gcp = orgSettings?.gcp ?? {};
  // Single shared GCP project + service account back every Google integration.
  const serviceAccountJson =
    gcp.serviceAccountJson || process.env['GOOGLE_SERVICE_ACCOUNT_JSON'] || '';
  const gcpProjectId = gcp.projectId || process.env['GCS_PROJECT_ID'] || '';
  const googleAdminEmail = cfg.googleAdminEmail || process.env['GOOGLE_ADMIN_EMAIL'] || '';
  const googleDomain = cfg.googleDomain || process.env['GOOGLE_DOMAIN'] || '';
  const departedOuPath =
    cfg.departedOuPath || process.env['DEPARTED_OU_PATH'] || DEFAULT_DEPARTED_OU;
  const archiveOuPath = cfg.archiveOuPath || process.env['ARCHIVE_OU_PATH'] || undefined;
  const auditChannel = cfg.auditChannel || process.env['OFFBOARDING_AUDIT_CHANNEL'] || undefined;
  const envMock = (process.env['MOCK_GOOGLE_API'] ?? '').toLowerCase() === 'true';

  const hasCreds = Boolean(serviceAccountJson && googleAdminEmail);
  const mock = Boolean(cfg.mockMode) || envMock || !hasCreds;

  return {
    googleAdminEmail,
    googleDomain,
    serviceAccountJson,
    gcpProjectId,
    departedOuPath,
    mock,
    ...(cfg.enabled !== undefined ? { enabled: cfg.enabled } : {}),
    ...(archiveOuPath ? { archiveOuPath } : {}),
    ...(auditChannel ? { auditChannel } : {}),
    ...(cfg.trackingProjectId ? { trackingProjectId: cfg.trackingProjectId } : {}),
    ...(cfg.mockMode !== undefined ? { mockMode: cfg.mockMode } : {}),
  };
}

export class GoogleWorkspaceService {
  private mock: boolean;
  private cfg: ResolvedOffboardingConfig;
  private _directory?: admin_directory_v1.Admin;
  private _datatransfer?: admin_datatransfer_v1.Admin;

  constructor(cfg: ResolvedOffboardingConfig) {
    this.cfg = cfg;
    this.mock = cfg.mock;
    if (!this.mock) {
      const auth = this.buildAuth();
      this._directory = google.admin({ version: 'directory_v1', auth });
      this._datatransfer = google.admin({ version: 'datatransfer_v1', auth });
    }
  }

  private buildAuth() {
    let creds: { client_email?: string; private_key?: string };
    try {
      creds = JSON.parse(this.cfg.serviceAccountJson || '{}');
    } catch {
      throw new Error('Offboarding service-account JSON is not valid JSON.');
    }
    if (!creds.client_email || !creds.private_key) {
      throw new Error('Service-account JSON is missing client_email / private_key.');
    }
    // Domain-wide delegation: impersonate the configured super admin. All Google
    // calls run under the shared GCP project (quota/billing) when one is set.
    const jwt = new google.auth.JWT({
      email: creds.client_email,
      key: creds.private_key,
      scopes: SCOPES,
      subject: this.cfg.googleAdminEmail,
    });
    if (this.cfg.gcpProjectId) jwt.projectId = this.cfg.gcpProjectId;
    return jwt;
  }

  private get directory(): admin_directory_v1.Admin {
    if (!this._directory) throw new Error('Directory API not initialized (mock mode).');
    return this._directory;
  }

  // ── Profile lookup ────────────────────────────────────────────────────────

  /** Fetch a user record. Returns null for not-found / out-of-domain (404/403). */
  async getUser(email: string): Promise<admin_directory_v1.Schema$User | null> {
    if (this.mock) return mockUser(email);
    try {
      const res = await this.directory.users.get({ userKey: email });
      return res.data;
    } catch (err) {
      const status = httpStatus(err);
      if (status === 403 || status === 404) return null;
      throw err;
    }
  }

  /** Returns a UI-friendly profile card for the offboarding modal / page. */
  async lookupProfile(email: string): Promise<OffboardingProfileLookup> {
    try {
      const user = await this.getUser(email);
      if (!user) return { found: false, email };
      const orgUnit = Array.isArray(user.organizations) ? user.organizations[0] : undefined;
      const relations = Array.isArray(user.relations) ? user.relations : [];
      const manager = relations.find((r) => r.type === 'manager');
      const out: OffboardingProfileLookup = { found: true, email, suspended: user.suspended ?? false };
      if (user.name?.fullName) out.name = user.name.fullName;
      if (orgUnit?.description) out.employeeId = String(orgUnit.description);
      if (orgUnit?.title) out.jobTitle = String(orgUnit.title);
      if (orgUnit?.department) out.department = String(orgUnit.department);
      if (manager?.value) out.managerEmail = String(manager.value);
      return out;
    } catch (err) {
      logger.warn('Offboarding profile lookup failed', { email, err });
      return { found: false, email, error: parseError(err) };
    }
  }

  /** True if the given OU path exists. */
  async checkOuExists(ouPath: string): Promise<boolean> {
    if (this.mock) return true;
    const path = ouPath.replace(/^\/+/, '');
    try {
      await this.directory.orgunits.get({ customerId: 'my_customer', orgUnitPath: path });
      return true;
    } catch (err) {
      if (httpStatus(err) === 404) return false;
      throw err;
    }
  }

  // ── Mutations ───────────────────────────────────────────────────────────────

  async suspendUser(email: string): Promise<OffboardingActionResult> {
    const action = 'Suspend Google Workspace account';
    if (this.mock) {
      return { action, success: true, details: `[MOCK] Account ${email} suspended successfully.` };
    }
    try {
      await this.directory.users.update({ userKey: email, requestBody: { suspended: true } });
      logger.info('Offboarding: suspended user', { email });
      return { action, success: true, details: `Account ${email} suspended.` };
    } catch (err) {
      const msg = parseError(err);
      logger.error('Offboarding: suspend failed', { email, msg });
      return { action, success: false, details: '', error: msg };
    }
  }

  async moveToOu(email: string, ouPath?: string): Promise<OffboardingActionResult> {
    const ou = ouPath || this.cfg.departedOuPath;
    const action = `Move to '${ou}' OU`;
    if (this.mock) {
      return { action, success: true, details: `[MOCK] ${email} moved to '${ou}'.` };
    }
    try {
      await this.directory.users.update({ userKey: email, requestBody: { orgUnitPath: ou } });
      logger.info('Offboarding: moved user to OU', { email, ou });
      return { action, success: true, details: `${email} moved to '${ou}'.` };
    } catch (err) {
      const msg = parseError(err);
      logger.error('Offboarding: OU move failed', { email, msg });
      return { action, success: false, details: '', error: msg };
    }
  }

  async transferDriveData(fromEmail: string, toEmail: string): Promise<OffboardingActionResult> {
    const action = `Transfer Drive files to ${toEmail}`;
    if (this.mock) {
      return {
        action,
        success: true,
        details: `[MOCK] Drive transfer from ${fromEmail} to ${toEmail} initiated.`,
      };
    }
    try {
      const [fromUser, toUser] = await Promise.all([
        this.directory.users.get({ userKey: fromEmail }),
        this.directory.users.get({ userKey: toEmail }),
      ]);
      const fromId = fromUser.data.id;
      const toId = toUser.data.id;
      if (!fromId || !toId) {
        return { action, success: false, details: '', error: 'Could not resolve user IDs for transfer.' };
      }

      const dt = this._datatransfer!;
      const apps = await dt.applications.list({ customerId: 'my_customer' });
      const driveApp = (apps.data.applications ?? []).find((a) =>
        (a.name ?? '').toLowerCase().includes('drive'),
      );
      if (!driveApp?.id) {
        return { action, success: false, details: '', error: 'Drive application not found in Data Transfer API.' };
      }

      await dt.transfers.insert({
        requestBody: {
          oldOwnerUserId: fromId,
          newOwnerUserId: toId,
          applicationDataTransfers: [
            {
              applicationId: driveApp.id,
              applicationTransferParams: [{ key: 'PRIVACY_LEVEL', value: ['PRIVATE', 'SHARED'] }],
            },
          ],
        },
      });
      logger.info('Offboarding: Drive transfer initiated', { fromEmail, toEmail });
      return { action, success: true, details: `Drive transfer from ${fromEmail} to ${toEmail} initiated.` };
    } catch (err) {
      const msg = parseError(err);
      logger.error('Offboarding: Drive transfer failed', { msg });
      return { action, success: false, details: '', error: msg };
    }
  }
}

/** Build a service for the given org settings (decrypted). */
export function makeGoogleWorkspaceService(orgSettings?: OrganizationSettings): GoogleWorkspaceService {
  return new GoogleWorkspaceService(resolveOffboardingConfig(orgSettings));
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function mockUser(email: string): admin_directory_v1.Schema$User {
  const name = email
    .split('@')[0]!
    .replace(/[._]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
  return {
    id: '123456789',
    primaryEmail: email,
    name: { fullName: name },
    suspended: false,
    orgUnitPath: '/',
    organizations: [{ title: 'Software Engineer', department: 'Engineering', description: 'EMP-12345' }],
    relations: [{ type: 'manager', value: `manager@${email.split('@')[1] ?? 'example.com'}` }],
  };
}

function httpStatus(err: unknown): number | undefined {
  const e = err as { code?: number; response?: { status?: number } };
  return e?.response?.status ?? (typeof e?.code === 'number' ? e.code : undefined);
}

function parseError(err: unknown): string {
  const e = err as { errors?: Array<{ message?: string }>; message?: string };
  return e?.errors?.[0]?.message ?? e?.message ?? String(err);
}
