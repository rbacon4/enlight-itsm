/**
 * Offline license key verification.
 *
 * License keys are Ed25519-signed JSON payloads.  The vendor signs them with
 * a private key that never leaves their infrastructure; this module verifies
 * with the corresponding public key baked into the binary.
 *
 * Key format:
 *   base64url(JSON.stringify(payload)) + "." + base64url(Ed25519 signature)
 *
 * Payload shape:
 *   { customer, email, plan, maxAgents, issuedAt, expiresAt }
 *
 * Behaviour:
 *   • Valid + not expired  → ACTIVE
 *   • Valid + in grace (≤30 days past expiry) → GRACE
 *   • Valid + expired > 30 days → EXPIRED
 *   • Bad signature or malformed → INVALID
 *   • No key configured → UNLICENSED
 *
 * A missing or expired license never crashes the app — it shows a banner in
 * the Settings → License UI and logs a warning on boot.  Feature gating is
 * left to future iterations; for now the app runs fully in all states.
 */

import crypto from 'crypto';
import { logger } from './logger.js';

// ── Vendor public key (Ed25519, raw 32 bytes, hex-encoded) ────────────────────
// Replace this with your actual public key before shipping.
// Generate a keypair:  node -e "const c=require('crypto');const k=c.generateKeyPairSync('ed25519');console.log(k.publicKey.export({type:'spki',format:'der'}).slice(-32).toString('hex'));console.log(k.privateKey.export({type:'pkcs8',format:'der'}).slice(-32).toString('hex'));"
const VENDOR_PUBLIC_KEY_HEX =
  process.env['LICENSE_PUBLIC_KEY'] ??
  '0000000000000000000000000000000000000000000000000000000000000000';

export type LicensePlan = 'starter' | 'team' | 'growth' | 'enterprise';

export interface LicensePayload {
  customer: string;
  email: string;
  plan: LicensePlan;
  /** Maximum number of agent-role users. 0 = unlimited. */
  maxAgents: number;
  issuedAt: string;   // ISO date
  expiresAt: string;  // ISO date
}

export type LicenseStatus = 'active' | 'grace' | 'expired' | 'invalid' | 'unlicensed';

export interface LicenseInfo {
  status: LicenseStatus;
  payload?: LicensePayload;
  /** Days until expiry (negative = days past expiry). */
  daysRemaining?: number;
  message: string;
}

const GRACE_DAYS = 30;

export function verifyLicense(key: string | null | undefined): LicenseInfo {
  if (!key?.trim()) {
    return { status: 'unlicensed', message: 'No license key configured.' };
  }

  const parts = key.trim().split('.');
  if (parts.length !== 2) {
    return { status: 'invalid', message: 'Malformed license key.' };
  }

  let payload: LicensePayload;
  let payloadBytes: Buffer;
  let sigBytes: Buffer;

  try {
    payloadBytes = Buffer.from(parts[0]!, 'base64url');
    payload = JSON.parse(payloadBytes.toString('utf8')) as LicensePayload;
    sigBytes = Buffer.from(parts[1]!, 'base64url');
  } catch {
    return { status: 'invalid', message: 'Malformed license key (could not decode).' };
  }

  // Verify Ed25519 signature.
  try {
    const pubKeyDer = buildSpkiDer(VENDOR_PUBLIC_KEY_HEX);
    const publicKey = crypto.createPublicKey({ key: pubKeyDer, format: 'der', type: 'spki' });
    const valid = crypto.verify(null, payloadBytes, publicKey, sigBytes);
    if (!valid) return { status: 'invalid', message: 'License signature is invalid.' };
  } catch {
    return { status: 'invalid', message: 'Could not verify license signature.' };
  }

  const now = new Date();
  const expiresAt = new Date(payload.expiresAt);
  const daysRemaining = Math.floor((expiresAt.getTime() - now.getTime()) / 86_400_000);

  if (daysRemaining >= 0) {
    return { status: 'active', payload, daysRemaining, message: `License active. Expires ${payload.expiresAt}.` };
  }
  if (-daysRemaining <= GRACE_DAYS) {
    return { status: 'grace', payload, daysRemaining,
      message: `License expired ${-daysRemaining} day(s) ago. ${GRACE_DAYS + daysRemaining} day(s) remaining in grace period.` };
  }
  return { status: 'expired', payload, daysRemaining,
    message: `License expired on ${payload.expiresAt}. Please renew.` };
}

/** Build a minimal SPKI DER for an Ed25519 raw public key (32 bytes). */
function buildSpkiDer(hexKey: string): Buffer {
  // SPKI prefix for Ed25519: 30 2a 30 05 06 03 2b 65 70 03 21 00
  const prefix = Buffer.from('302a300506032b6570032100', 'hex');
  const keyBytes = Buffer.from(hexKey, 'hex');
  if (keyBytes.length !== 32) throw new Error('Public key must be 32 bytes.');
  return Buffer.concat([prefix, keyBytes]);
}

// ── Module-level cache (verified once on first call) ─────────────────────────

let _cached: LicenseInfo | null = null;

export function getLicense(keyOverride?: string): LicenseInfo {
  if (_cached && !keyOverride) return _cached;
  const key = keyOverride ?? process.env['ENLIGHT_LICENSE_KEY'];
  _cached = verifyLicense(key);
  return _cached;
}

export function clearLicenseCache(): void {
  _cached = null;
}

/** Log license status on API boot. */
export function logLicenseStatus(): void {
  const info = getLicense();
  if (info.status === 'active') {
    logger.info('License valid', { plan: info.payload?.plan, expiresAt: info.payload?.expiresAt });
  } else if (info.status === 'unlicensed') {
    logger.warn('No license key configured — running unlicensed');
  } else {
    logger.warn('License issue', { status: info.status, message: info.message });
  }
}
