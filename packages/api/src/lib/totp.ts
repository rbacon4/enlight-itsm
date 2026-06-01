/**
 * Minimal TOTP (RFC 6238) implementation using Node.js built-in crypto.
 * No external dependency — just HMAC-SHA1 and Base32.
 */
import crypto from 'crypto';

// ── Base32 (RFC 4648 uppercase, no padding) ───────────────────────────────────

const B32_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0, val = 0, out = '';
  for (const byte of buf) {
    val = (val << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_CHARS[(val >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_CHARS[(val << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str: string): Buffer {
  const s = str.toUpperCase().replace(/=+$/, '');
  const bytes: number[] = [];
  let bits = 0, val = 0;
  for (const ch of s) {
    const idx = B32_CHARS.indexOf(ch);
    if (idx < 0) continue;
    val = (val << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((val >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

// ── TOTP ──────────────────────────────────────────────────────────────────────

/** Generate a new random Base32 TOTP secret. */
export function generateTotpSecret(bytes = 20): string {
  return base32Encode(crypto.randomBytes(bytes));
}

/** Compute a 6-digit TOTP code for the given epoch window step. */
function compute(secret: string, step: number): string {
  const key = base32Decode(secret);
  const msg = Buffer.alloc(8);
  msg.writeBigInt64BE(BigInt(step));
  const hmac = crypto.createHmac('sha1', key).update(msg).digest();
  const offset = (hmac[hmac.length - 1]! & 0x0f);
  const code = ((hmac[offset]! & 0x7f) << 24) |
               ((hmac[offset + 1]! & 0xff) << 16) |
               ((hmac[offset + 2]! & 0xff) << 8) |
               (hmac[offset + 3]! & 0xff);
  return String(code % 1_000_000).padStart(6, '0');
}

/** Verify a token, allowing ±1 time-step for clock drift. */
export function verifyTotp(secret: string, token: string): boolean {
  const step = Math.floor(Date.now() / 30_000);
  return [-1, 0, 1].some((d) => compute(secret, step + d) === token);
}

/** Build an otpauth:// URI for QR codes. */
export function totpUri(accountName: string, secret: string, issuer: string): string {
  const enc = encodeURIComponent;
  return `otpauth://totp/${enc(issuer)}:${enc(accountName)}?secret=${secret}&issuer=${enc(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
