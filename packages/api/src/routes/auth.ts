import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcrypt';
import { db } from '../db/client.js';
import { users, organizations } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { signToken } from '../middleware/auth.js';
import { signTotpToken } from './totp.js';
import { Errors } from '../lib/errors.js';
import { ensureBuiltinRoles } from '../lib/roleSeed.js';
import { builtinGlobalRoleId } from '../lib/permissions.js';
import { z } from 'zod';

const router = Router();

// Brute-force protection for credential endpoints. Counts only FAILED attempts
// (skipSuccessfulRequests), so a legitimate user logging in repeatedly is never
// blocked, while an attacker spraying passwords is throttled per IP. Replies with
// HTTP 429 + Retry-After (standardHeaders). This is the API-layer enforcement the
// frontend cannot bypass.
const credentialLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // failed attempts per IP per window
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'TOO_MANY_REQUESTS',
    message: 'Too many login attempts. Please try again later.',
    statusCode: 429,
  },
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

// POST /auth/login  — local email/password login (used before SAML is configured)
router.post('/login', credentialLimiter, async (req, res, next) => {
  try {
    const body = loginSchema.parse(req.body);

    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.email, body.email))
      .limit(1);

    if (!user?.passwordHash) {
      next(Errors.unauthorized());
      return;
    }

    const valid = await bcrypt.compare(body.password, user.passwordHash);
    if (!valid) {
      next(Errors.unauthorized());
      return;
    }

    if (!user.active) {
      next(Errors.forbidden());
      return;
    }

    // If TOTP is enabled, issue a short-lived challenge token instead of a full session.
    if (user.totpEnabled) {
      res.json({ requiresTotp: true, totpToken: signTotpToken(user.id) });
      return;
    }

    const token = signToken({
      id: user.id,
      orgId: user.orgId,
      email: user.email,
      name: user.name,
      globalRole: user.globalRole,
    });

    res.json({ token });
  } catch (err) {
    next(err);
  }
});

// GET /auth/setup-status — unauthenticated probe: has the instance been initialised yet?
router.get('/setup-status', async (_req, res, next) => {
  try {
    const existing = await db.select({ id: organizations.id }).from(organizations).limit(1);
    res.json({ needsSetup: existing.length === 0 });
  } catch (err) {
    next(err);
  }
});

// POST /auth/setup  — create the first organization + super admin (only works when no orgs exist)
const setupSchema = z.object({
  orgName: z.string().min(1),
  email: z.string().email(),
  name: z.string().min(1),
  password: z.string().min(8),
});

router.post('/setup', credentialLimiter, async (req, res, next) => {
  try {
    // Authorization guard FIRST — before any field validation. Once an org
    // exists the instance is initialised, so reject immediately with 403. This
    // closes the re-initialisation path and avoids leaking the setup flow
    // (field-validation errors) to unauthenticated callers.
    const existing = await db.select({ id: organizations.id }).from(organizations).limit(1);
    if (existing.length > 0) {
      next(Errors.conflict('Setup already complete'));
      return;
    }

    const body = setupSchema.parse(req.body);

    const [org] = await db
      .insert(organizations)
      .values({ name: body.orgName, settings: {} })
      .returning();

    if (!org) throw Errors.internal();

    // Seed the org's built-in RBAC roles, then assign the super admin role.
    await ensureBuiltinRoles(org.id);
    const superRoleId = await builtinGlobalRoleId(org.id, 'super_admin');

    const passwordHash = await bcrypt.hash(body.password, 12);

    const [user] = await db
      .insert(users)
      .values({
        orgId: org.id,
        email: body.email,
        name: body.name,
        passwordHash,
        globalRole: 'super_admin',
        roleId: superRoleId,
      })
      .returning();

    if (!user) throw Errors.internal();

    const token = signToken({
      id: user.id,
      orgId: user.orgId,
      email: user.email,
      name: user.name,
      globalRole: user.globalRole,
    });

    res.status(201).json({ token, org, user: { ...user, passwordHash: undefined } });
  } catch (err) {
    next(err);
  }
});

export { router as authRouter };
