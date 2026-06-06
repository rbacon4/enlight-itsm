/**
 * Rippling IT integration.
 *
 * Handles directory sync and offboarding (deactivate worker, revoke app access,
 * unenroll devices). Falls back to complete mock mode when no credentials are
 * configured — every method returns realistic stub data with zero network calls.
 *
 * No new npm dependencies — uses fetch for all HTTP.
 */
import type { OrganizationSettings, RipplingWorker, RipplingDevice, RipplingWorkerPage } from '@enlight/shared';
import { logger } from './logger.js';

const BASE_URL = 'https://rest.ripplingapis.com';
const DEFAULT_VERSION = '2024-01-31';

export interface RipplingOffboardingResult {
  deactivated: boolean;
  appsRevoked: boolean;
  devicesUnenrolled: number;
  mock: boolean;
  error?: string;
}

function isMockMode(settings?: OrganizationSettings): boolean {
  if ((process.env['MOCK_RIPPLING_API'] ?? '').toLowerCase() === 'true') return true;
  const r = settings?.rippling;
  if (!r?.apiToken) return true;
  return false;
}

export class RipplingClient {
  private apiToken: string;
  private apiVersion: string;
  private mock: boolean;

  constructor(private settings?: OrganizationSettings) {
    this.mock = isMockMode(settings);
    this.apiToken = settings?.rippling?.apiToken ?? '';
    this.apiVersion = settings?.rippling?.apiVersion ?? process.env['RIPPLING_API_VERSION'] ?? DEFAULT_VERSION;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiToken}`,
      'Rippling-Api-Version': this.apiVersion,
      'Content-Type': 'application/json',
    };
  }

  /** Exponential backoff on 429 (max 3 retries). */
  private async fetch(method: string, path: string, body?: unknown): Promise<Response> {
    const url = `${BASE_URL}${path}`;
    const delays = [1000, 2000, 4000];
    let lastErr: unknown;
    for (let attempt = 0; attempt <= 3; attempt++) {
      try {
        const res = await fetch(url, {
          method,
          headers: this.headers(),
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
    throw lastErr ?? new Error('Rippling fetch failed after retries');
  }

  async listWorkers(opts?: { cursor?: string; limit?: number }): Promise<RipplingWorkerPage> {
    if (this.mock) {
      return {
        data: [
          {
            id: 'rip-mock-001', workEmail: 'jane.smith@example.com', personalEmail: 'jane@personal.com',
            name: { firstName: 'Jane', lastName: 'Smith' },
            department: 'Engineering', title: 'Software Engineer',
            employmentStatus: 'ACTIVE', employeeNumber: 'EMP-001',
          },
          {
            id: 'rip-mock-002', workEmail: 'bob.jones@example.com',
            name: { firstName: 'Bob', lastName: 'Jones' },
            department: 'Sales', title: 'Account Executive',
            employmentStatus: 'ACTIVE', employeeNumber: 'EMP-002',
          },
        ],
      };
    }
    const params = new URLSearchParams();
    if (opts?.cursor) params.set('cursor', opts.cursor);
    if (opts?.limit) params.set('limit', String(opts.limit));
    const qs = params.toString();
    const res = await this.fetch('GET', `/platform/api/workers${qs ? `?${qs}` : ''}`);
    if (!res.ok) throw new Error(`Rippling listWorkers failed (${res.status})`);
    return (await res.json()) as RipplingWorkerPage;
  }

  async getWorker(id: string): Promise<RipplingWorker | null> {
    if (this.mock) {
      return {
        id, workEmail: `worker-${id}@example.com`,
        name: { firstName: 'Mock', lastName: 'Worker' },
        employmentStatus: 'ACTIVE',
      };
    }
    const res = await this.fetch('GET', `/platform/api/workers/${id}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Rippling getWorker failed (${res.status})`);
    return (await res.json()) as RipplingWorker;
  }

  async deactivateWorker(id: string): Promise<boolean> {
    if (this.mock) {
      logger.info('[MOCK] Rippling: deactivated worker', { id });
      return true;
    }
    const res = await this.fetch('POST', `/platform/api/workers/${id}/deactivate`);
    if (!res.ok) {
      logger.warn('Rippling deactivateWorker failed', { id, status: res.status });
      return false;
    }
    return true;
  }

  async revokeAppAccess(workerId: string): Promise<boolean> {
    if (this.mock) {
      logger.info('[MOCK] Rippling: revoked app access', { workerId });
      return true;
    }
    const res = await this.fetch('POST', `/platform/api/workers/${workerId}/revoke_app_access`);
    if (!res.ok) {
      logger.warn('Rippling revokeAppAccess failed', { workerId, status: res.status });
      return false;
    }
    return true;
  }

  async listDevices(workerId: string): Promise<RipplingDevice[]> {
    if (this.mock) {
      return [
        { id: 'dev-mock-001', name: 'MacBook Pro', serial: 'C02XL012', platform: 'macOS', enrollmentStatus: 'enrolled' },
      ];
    }
    const res = await this.fetch('GET', `/platform/api/workers/${workerId}/devices`);
    if (!res.ok) {
      logger.warn('Rippling listDevices failed', { workerId, status: res.status });
      return [];
    }
    const data = (await res.json()) as { data?: RipplingDevice[] };
    return data.data ?? [];
  }

  async unenrollDevice(deviceId: string): Promise<boolean> {
    if (this.mock) {
      logger.info('[MOCK] Rippling: unenrolled device', { deviceId });
      return true;
    }
    const res = await this.fetch('POST', `/platform/api/devices/${deviceId}/unenroll`);
    if (!res.ok) {
      logger.warn('Rippling unenrollDevice failed', { deviceId, status: res.status });
      return false;
    }
    return true;
  }

  async testConnection(): Promise<{ ok: boolean; workerCount?: number; error?: string }> {
    if (this.mock) {
      return { ok: true, workerCount: 2 };
    }
    try {
      const page = await this.listWorkers({ limit: 1 });
      return { ok: true, workerCount: page.data.length };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Run the offboarding flow for a departing employee (lookup by work email). */
  async offboardByEmail(email: string, unenrollDevices: boolean): Promise<RipplingOffboardingResult> {
    const result: RipplingOffboardingResult = {
      deactivated: false,
      appsRevoked: false,
      devicesUnenrolled: 0,
      mock: this.mock,
    };

    try {
      // Find worker by email
      let workerId: string | null = null;
      if (this.mock) {
        workerId = `rip-mock-${email}`;
      } else {
        const page = await this.listWorkers();
        const found = page.data.find(w => w.workEmail.toLowerCase() === email.toLowerCase());
        if (!found) {
          result.error = `Worker with email ${email} not found in Rippling`;
          return result;
        }
        workerId = found.id;
      }

      result.deactivated = await this.deactivateWorker(workerId);
      result.appsRevoked = await this.revokeAppAccess(workerId);

      if (unenrollDevices) {
        const devices = await this.listDevices(workerId);
        for (const device of devices) {
          const ok = await this.unenrollDevice(device.id);
          if (ok) result.devicesUnenrolled++;
        }
      }
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
      logger.error('Rippling offboarding error', { email, err });
    }

    return result;
  }
}

export function makeRipplingClient(settings?: OrganizationSettings): RipplingClient {
  return new RipplingClient(settings);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
