/**
 * Executes an offboarding checklist's automated steps — a configured REST API
 * call that deactivates the departing user in an app without SCIM deprovisioning.
 *
 * Shared by the orchestrator (lib/offboarding.ts) and the settings "Test call"
 * route. Template variables are substituted from a fixed, documented set only
 * (no arbitrary eval), and a lightweight SSRF guard blocks internal targets.
 */
import type { OffboardingActionResult, ChecklistAuthType } from '@enlight/shared';
import { logger } from './logger.js';

export interface TemplateVars {
  targetEmail: string;
  delegateEmail?: string | null;
}

/** The request portion of an automated step (decrypted credential already resolved). */
export interface AutomatedStepRequest {
  name: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  bodyTemplate?: string | null;
  authType: ChecklistAuthType;
  authHeaderName?: string | null;
  /** Decrypted secret (bearer token / api key value / "user:pass"). */
  credential?: string | null;
  expectedStatusMin: number;
  expectedStatusMax: number;
}

/** Build the full variable map from the target/delegate identity. */
export function buildVars(v: TemplateVars): Record<string, string> {
  const local = v.targetEmail.split('@')[0] ?? '';
  const parts = local.split(/[._-]+/).filter(Boolean);
  return {
    targetEmail: v.targetEmail,
    targetUserName: local,
    targetFirstName: cap(parts[0] ?? ''),
    targetLastName: cap(parts[parts.length - 1] ?? ''),
    delegateEmail: v.delegateEmail ?? '',
    date: new Date().toISOString().slice(0, 10),
  };
}

/** Substitute {{var}} tokens from the fixed variable set; unknown tokens are left as-is. */
export function renderTemplate(str: string, vars: Record<string, string>): string {
  return str.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key]! : m,
  );
}

/** Block obviously-internal/loopback/link-local targets (defense-in-depth SSRF guard). */
export function isBlockedUrl(rawUrl: string): string | null {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return 'URL is not valid.';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'Only http(s) URLs are allowed.';
  const host = u.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host.endsWith('.localhost') ||
    host.endsWith('.internal') ||
    host === '169.254.169.254' ||          // cloud metadata
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) // 172.16/12
  ) {
    return `Target host "${host}" is internal/loopback and is not allowed.`;
  }
  return null;
}

/**
 * Run one automated step. Renders the request, attaches auth, fires it with a
 * timeout, and maps the outcome to an OffboardingActionResult. Never throws.
 */
export async function runAutomatedStep(
  step: AutomatedStepRequest,
  vars: Record<string, string>,
): Promise<OffboardingActionResult & { status?: number; responseSnippet?: string }> {
  const action = step.name;
  const method = (step.method || 'POST').toUpperCase();
  const url = renderTemplate(step.url, vars);

  const blocked = isBlockedUrl(url);
  if (blocked) return { action, success: false, details: '', error: blocked };

  // Headers (rendered) + auth.
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(step.headers ?? {})) headers[k] = renderTemplate(v, vars);
  applyAuth(headers, step);

  let body: string | undefined;
  if (step.bodyTemplate && method !== 'GET' && method !== 'HEAD') {
    body = renderTemplate(step.bodyTemplate, vars);
    if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) {
      headers['Content-Type'] = 'application/json';
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const init: RequestInit = { method, headers, signal: controller.signal };
    if (body !== undefined) init.body = body;
    const res = await fetch(url, init);
    const text = (await res.text().catch(() => '')).slice(0, 2000);
    const ok = res.status >= step.expectedStatusMin && res.status <= step.expectedStatusMax;
    return {
      action,
      success: ok,
      details: ok ? `${method} ${url} → ${res.status}` : '',
      ...(ok ? {} : { error: `${method} ${url} → ${res.status}` }),
      status: res.status,
      responseSnippet: text,
    };
  } catch (err) {
    const e = err instanceof Error && err.name === 'AbortError' ? 'Request timed out (15s).' : (err instanceof Error ? err.message : String(err));
    logger.warn('Automated checklist step failed', { action, e });
    return { action, success: false, details: '', error: e };
  } finally {
    clearTimeout(timer);
  }
}

function applyAuth(headers: Record<string, string>, step: AutomatedStepRequest): void {
  const cred = step.credential ?? '';
  if (!cred) return;
  switch (step.authType) {
    case 'bearer':
      headers['Authorization'] = `Bearer ${cred}`;
      break;
    case 'api_key':
      headers[step.authHeaderName || 'X-API-Key'] = cred;
      break;
    case 'basic':
      headers['Authorization'] = `Basic ${Buffer.from(cred).toString('base64')}`;
      break;
    case 'none':
    default:
      break;
  }
}

function cap(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
