// Application-level encryption for reversible secrets stored in the database
// (org provider API keys + Slack tokens). Values are encrypted with AES-256-GCM
// and tagged with a version prefix so the codec is backward-compatible with
// legacy plaintext and idempotent on already-encrypted values.
import crypto from 'crypto';
import type { OrganizationSettings } from '@enlight/shared';
import { logger } from './logger.js';

const PREFIX = 'enc:v1:';

/** Settings keys that hold reversible secrets and must be encrypted at rest. */
const SECRET_KEYS = [
  'anthropicApiKey', 'voyageApiKey', 'openAiApiKey',
  'slackBotToken', 'slackSigningSecret', 'slackAppToken',
] as const;

let cachedKey: Buffer | null = null;
let warnedFallback = false;

/**
 * Resolves the 32-byte AES key. Prefers SECRETS_ENCRYPTION_KEY (hex/base64/raw);
 * otherwise derives a deterministic key from JWT_SECRET so encryption works out
 * of the box in dev. A dedicated key should be set in production.
 */
function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  const explicit = process.env['SECRETS_ENCRYPTION_KEY'];
  if (explicit) {
    if (/^[0-9a-fA-F]{64}$/.test(explicit)) cachedKey = Buffer.from(explicit, 'hex');
    else {
      const b = Buffer.from(explicit, 'base64');
      cachedKey = b.length === 32 ? b : crypto.createHash('sha256').update(explicit).digest();
    }
  } else {
    if (!warnedFallback) {
      logger.warn('SECRETS_ENCRYPTION_KEY not set — deriving secret-encryption key from JWT_SECRET. Set a dedicated key in production.');
      warnedFallback = true;
    }
    const jwtSecret = process.env['JWT_SECRET'] ?? 'dev-secret-change-me';
    cachedKey = crypto.createHash('sha256').update(`enlight-secrets:${jwtSecret}`).digest();
  }
  return cachedKey;
}

/** Encrypts a string. No-op for empty values or already-encrypted values. */
export function encryptSecret(plain: string): string {
  if (!plain || plain.startsWith(PREFIX)) return plain;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ct]).toString('base64');
}

/** Decrypts a tagged value. Passes through plaintext/legacy/empty values unchanged. */
export function decryptSecret(value: string): string {
  if (!value || !value.startsWith(PREFIX)) return value;
  try {
    const raw = Buffer.from(value.slice(PREFIX.length), 'base64');
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const ct = raw.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch (err) {
    // Wrong key / corrupt data — don't crash; return the stored value as-is.
    logger.error('Failed to decrypt a stored secret', { err });
    return value;
  }
}

function mapSecrets(settings: OrganizationSettings, fn: (v: string) => string): OrganizationSettings {
  const out = { ...settings } as Record<string, unknown>;
  for (const k of SECRET_KEYS) {
    const v = out[k];
    if (typeof v === 'string' && v) out[k] = fn(v);
  }
  // Nested secret: gcp.serviceAccountJson (a shared service-account key file).
  const gcp = out['gcp'];
  if (gcp && typeof gcp === 'object') {
    const g = { ...(gcp as Record<string, unknown>) };
    if (typeof g['serviceAccountJson'] === 'string' && g['serviceAccountJson']) {
      g['serviceAccountJson'] = fn(g['serviceAccountJson'] as string);
    }
    out['gcp'] = g;
  }
  // Nested secrets: aws.secretAccessKey + digitalocean.secretAccessKey.
  for (const provider of ['aws', 'digitalocean'] as const) {
    const p = out[provider];
    if (p && typeof p === 'object') {
      const c = { ...(p as Record<string, unknown>) };
      if (typeof c['secretAccessKey'] === 'string' && c['secretAccessKey']) {
        c['secretAccessKey'] = fn(c['secretAccessKey'] as string);
      }
      out[provider] = c;
    }
  }
  // Nested secret: offboarding.microsoft.clientSecret (M365 app registration secret).
  const off = out['offboarding'];
  if (off && typeof off === 'object') {
    const o = { ...(off as Record<string, unknown>) };
    const ms = o['microsoft'];
    if (ms && typeof ms === 'object') {
      const m = { ...(ms as Record<string, unknown>) };
      if (typeof m['clientSecret'] === 'string' && m['clientSecret']) {
        m['clientSecret'] = fn(m['clientSecret'] as string);
      }
      o['microsoft'] = m;
      out['offboarding'] = o;
    }
  }
  // Nested secrets: rippling.apiToken
  const rippling = out['rippling'];
  if (rippling && typeof rippling === 'object') {
    const r = { ...(rippling as Record<string, unknown>) };
    if (typeof r['apiToken'] === 'string' && r['apiToken']) r['apiToken'] = fn(r['apiToken'] as string);
    out['rippling'] = r;
  }
  // Nested secrets: jumpcloud.apiKey, jumpcloud.clientSecret, jumpcloud.cachedAccessToken
  const jumpcloud = out['jumpcloud'];
  if (jumpcloud && typeof jumpcloud === 'object') {
    const j = { ...(jumpcloud as Record<string, unknown>) };
    for (const k of ['apiKey', 'clientSecret', 'cachedAccessToken'] as const) {
      if (typeof j[k] === 'string' && j[k]) j[k] = fn(j[k] as string);
    }
    out['jumpcloud'] = j;
  }
  // Nested secrets: okta.apiToken, okta.privateKeyJwk, okta.cachedAccessToken
  const okta = out['okta'];
  if (okta && typeof okta === 'object') {
    const o = { ...(okta as Record<string, unknown>) };
    for (const k of ['apiToken', 'privateKeyJwk', 'cachedAccessToken'] as const) {
      if (typeof o[k] === 'string' && o[k]) o[k] = fn(o[k] as string);
    }
    out['okta'] = o;
  }
  return out as OrganizationSettings;
}

/** Returns a copy of org settings with secret fields encrypted (for writes). */
export function encryptOrgSettings(settings: OrganizationSettings): OrganizationSettings {
  return mapSecrets(settings, encryptSecret);
}

/** Returns a copy of org settings with secret fields decrypted (for reads/use). */
export function decryptOrgSettings(settings: OrganizationSettings): OrganizationSettings {
  return mapSecrets(settings, decryptSecret);
}
