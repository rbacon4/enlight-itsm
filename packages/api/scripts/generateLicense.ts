#!/usr/bin/env tsx
/**
 * License key generator — vendor-only tool.
 *
 * Usage:
 *   # Generate a new keypair (first time only — keep the private key secret!)
 *   pnpm --filter @enlight/api exec tsx scripts/generateLicense.ts --keygen
 *
 *   # Issue a license
 *   ENLIGHT_LICENSE_PRIVATE_KEY=<hex> \
 *   pnpm --filter @enlight/api exec tsx scripts/generateLicense.ts \
 *     --customer "Acme Corp" \
 *     --email admin@acme.com \
 *     --plan starter \
 *     --max-agents 5 \
 *     --expires 2027-06-01
 *
 * The generated key is printed to stdout — deliver it to the customer via your
 * license server or email. Paste it into Settings → License in the app.
 */

import crypto from 'crypto';

const args = process.argv.slice(2);
const get = (flag: string) => {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : undefined;
};

if (args.includes('--keygen')) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const pubRaw  = publicKey.export({ type: 'spki',  format: 'der' }).slice(-32).toString('hex');
  const privRaw = privateKey.export({ type: 'pkcs8', format: 'der' }).slice(-32).toString('hex');
  console.log('\n=== Ed25519 Keypair ===');
  console.log('PUBLIC KEY (bake into app via LICENSE_PUBLIC_KEY env var):');
  console.log(pubRaw);
  console.log('\nPRIVATE KEY (keep secret! set as ENLIGHT_LICENSE_PRIVATE_KEY env var):');
  console.log(privRaw);
  console.log('\n⚠  Never commit the private key to version control.\n');
  process.exit(0);
}

const privHex = process.env['ENLIGHT_LICENSE_PRIVATE_KEY'];
if (!privHex) {
  console.error('Error: ENLIGHT_LICENSE_PRIVATE_KEY env var is required.');
  process.exit(1);
}

const customer  = get('--customer')   ?? 'Unknown Customer';
const email     = get('--email')      ?? 'admin@example.com';
const plan      = (get('--plan')      ?? 'starter') as 'starter' | 'team' | 'growth' | 'enterprise';
const maxAgents = parseInt(get('--max-agents') ?? '5', 10);
const expiresAt = get('--expires')    ?? new Date(Date.now() + 365 * 86400_000).toISOString().slice(0, 10);

const payload = {
  customer,
  email,
  plan,
  maxAgents,
  issuedAt: new Date().toISOString().slice(0, 10),
  expiresAt,
};

const payloadBytes = Buffer.from(JSON.stringify(payload));
const payloadB64   = payloadBytes.toString('base64url');

// Build PKCS#8 DER from raw 32-byte private key + Ed25519 public key derivation.
const privRaw = Buffer.from(privHex, 'hex');
// PKCS8 prefix for Ed25519 private key: 302e020100300506032b657004220420
const pkcs8Prefix = Buffer.from('302e020100300506032b657004220420', 'hex');
const privDer = Buffer.concat([pkcs8Prefix, privRaw]);
const privateKey = crypto.createPrivateKey({ key: privDer, format: 'der', type: 'pkcs8' });

const sig    = crypto.sign(null, payloadBytes, privateKey);
const sigB64 = sig.toString('base64url');

const licenseKey = `${payloadB64}.${sigB64}`;

console.log('\n=== License Key ===');
console.log(licenseKey);
console.log('\nPayload:');
console.log(JSON.stringify(payload, null, 2));
console.log('\nDeliver the license key to the customer. They enter it in Settings → License.\n');
