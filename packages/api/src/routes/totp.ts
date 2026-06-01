/**
 * TOTP (authenticator app) 2FA — mounted at /auth/totp.
 *
 *  POST /auth/totp/setup    — generate a TOTP secret + QR code (requires auth; does NOT enable)
 *  POST /auth/totp/confirm  — verify the first code to activate 2FA
 *  POST /auth/totp/verify   — verify a code during the second-step login flow
 *  DELETE /auth/totp        — disable 2FA (requires a current TOTP code)
 *
 * Login flow (when totpEnabled = true):
 *   1. POST /auth/login with email+password
 *      → returns { requiresTotp: true, totpToken: "<short-lived JWT>" }
 *   2. POST /auth/totp/verify with { totpToken, code }
 *      → returns { token: "<full session JWT>" }
 */
import { Router } from 'express';
import { generateTotpSecret, verifyTotp, totpUri } from '../lib/totp.js';
import QRCode from 'qrcode';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import jwt from 'jsonwebtoken';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { requireAuth, signToken } from '../middleware/auth.js';
import { encryptSecret, decryptSecret } from '../lib/secretCrypto.js';
import { Errors } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

const router = Router();

const JWT_SECRET = process.env['JWT_SECRET'] ?? 'dev-secret-change-me';
const APP_NAME = process.env['APP_NAME'] ?? 'Enlight ITSM';

// ── POST /auth/totp/setup ─────────────────────────────────────────────────────
// Generates a new TOTP secret, stores it encrypted (but NOT yet enabled),
// and returns a QR code data URL for the user to scan.

router.post('/setup', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const [user] = await db.select({ email: users.email, totpEnabled: users.totpEnabled })
      .from(users).where(eq(users.id, userId)).limit(1);
    if (!user) { next(Errors.notFound('User')); return; }
    if (user.totpEnabled) {
      res.status(409).json({ error: 'TOTP is already enabled. Disable it first.' });
      return;
    }

    const secret = generateTotpSecret(20);
    const otpauth = totpUri(user.email, secret, APP_NAME);
    const qrDataUrl = await QRCode.toDataURL(otpauth);

    // Store encrypted secret but don't enable yet.
    await db.update(users)
      .set({ totpSecret: encryptSecret(secret), totpEnabled: false, updatedAt: new Date() })
      .where(eq(users.id, userId));

    res.json({ secret, qrDataUrl, otpauth });
  } catch (err) { next(err); }
});

// ── POST /auth/totp/confirm ───────────────────────────────────────────────────
// Verifies the first code from the authenticator app to activate 2FA.

router.post('/confirm', requireAuth, async (req, res, next) => {
  try {
    const { code } = z.object({ code: z.string().min(6).max(8) }).parse(req.body);
    const userId = req.user!.id;

    const [user] = await db
      .select({ totpSecret: users.totpSecret, totpEnabled: users.totpEnabled })
      .from(users).where(eq(users.id, userId)).limit(1);

    if (!user?.totpSecret) {
      res.status(400).json({ error: 'Call /auth/totp/setup first.' });
      return;
    }
    if (user.totpEnabled) {
      res.status(409).json({ error: 'TOTP is already enabled.' });
      return;
    }

    const secret = decryptSecret(user.totpSecret);
    if (!verifyTotp(secret, code)) {
      res.status(422).json({ error: 'Invalid code. Please try again.' });
      return;
    }

    await db.update(users)
      .set({ totpEnabled: true, updatedAt: new Date() })
      .where(eq(users.id, userId));

    res.json({ enabled: true });
  } catch (err) { next(err); }
});

// ── DELETE /auth/totp  or  POST /auth/totp/disable ────────────────────────────
// Disables 2FA. Requires a valid TOTP code to confirm intent.

async function handleDisable(req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) {
  try {
    const { code } = z.object({ code: z.string().min(6).max(8) }).parse(req.body);
    const userId = req.user!.id;

    const [user] = await db
      .select({ totpSecret: users.totpSecret, totpEnabled: users.totpEnabled })
      .from(users).where(eq(users.id, userId)).limit(1);

    if (!user?.totpEnabled || !user.totpSecret) {
      res.status(400).json({ error: 'TOTP is not enabled.' });
      return;
    }

    const secret = decryptSecret(user.totpSecret);
    if (!verifyTotp(secret, code)) {
      res.status(422).json({ error: 'Invalid code.' });
      return;
    }

    await db.update(users)
      .set({ totpEnabled: false, totpSecret: null, updatedAt: new Date() })
      .where(eq(users.id, userId));

    res.json({ enabled: false });
  } catch (err) { next(err); }
}

router.delete('/', requireAuth, handleDisable);
router.post('/disable', requireAuth, handleDisable);

// ── POST /auth/totp/verify ────────────────────────────────────────────────────
// Second step of login: validate TOTP code and return full session JWT.

router.post('/verify', async (req, res, next) => {
  try {
    const { totpToken, code } = z.object({
      totpToken: z.string(),
      code: z.string().min(6).max(8),
    }).parse(req.body);

    // Validate the short-lived TOTP token issued at step 1 of login.
    let payload: { sub: string; purpose: string };
    try {
      payload = jwt.verify(totpToken, JWT_SECRET) as typeof payload;
    } catch {
      res.status(401).json({ error: 'Invalid or expired TOTP token. Please log in again.' });
      return;
    }
    if (payload.purpose !== 'totp') {
      res.status(401).json({ error: 'Invalid token purpose.' });
      return;
    }

    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, payload.sub))
      .limit(1);

    if (!user || !user.active || !user.totpEnabled || !user.totpSecret) {
      res.status(401).json({ error: 'Authentication failed.' });
      return;
    }

    const secret = decryptSecret(user.totpSecret);
    if (!verifyTotp(secret, code)) {
      res.status(422).json({ error: 'Invalid code. Please try again.' });
      return;
    }

    const token = signToken({
      id: user.id, orgId: user.orgId, email: user.email,
      name: user.name, globalRole: user.globalRole,
    });

    logger.info('TOTP login complete', { userId: user.id });
    res.json({ token });
  } catch (err) { next(err); }
});

export { router as totpRouter };

// ── Exported helper for the login route ──────────────────────────────────────

/** Issues a short-lived (5 min) token used as the TOTP challenge in step 2. */
export function signTotpToken(userId: string): string {
  return jwt.sign({ sub: userId, purpose: 'totp' }, JWT_SECRET, { expiresIn: '5m' });
}
