/**
 * Public request portal — unauthenticated ticket submission.
 *
 * GET  /portal/:token          — returns project info (name, categories, custom fields)
 * POST /portal/:token/requests — submits a ticket; creates a guest user if needed
 *
 * The portal token is a random 32-byte hex string stored on the project.
 * Enabling/disabling the portal and rotating the token is done via the
 * PATCH /projects/:id endpoint (portalEnabled + portalToken fields).
 */
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projects, organizations, users } from '../db/schema.js';
import { createRequest } from '../lib/createRequest.js';
import { builtinGlobalRoleId } from '../lib/permissions.js';
import { Errors } from '../lib/errors.js';
import type { OrganizationSettings } from '@enlight/shared';

const router = Router();

// Strict per-IP rate limit for unauthenticated ticket submission (10 tickets/hr).
const submitLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'TOO_MANY_REQUESTS', message: 'Too many submissions from this IP. Please try again later.' },
});

async function findProjectByToken(token: string) {
  const [project] = await db
    .select({
      id: projects.id,
      name: projects.name,
      key: projects.key,
      orgId: projects.orgId,
      portalEnabled: projects.portalEnabled,
      categories: projects.categories,
      customFields: projects.customFields,
    })
    .from(projects)
    .where(eq(projects.portalToken, token))
    .limit(1);
  return project ?? null;
}

// GET /portal/:token — project info for the portal form
router.get('/:token', async (req, res, next) => {
  try {
    const project = await findProjectByToken(req.params['token'] as string);
    if (!project?.portalEnabled) { next(Errors.notFound('Portal')); return; }
    res.json({
      projectName: project.name,
      projectKey: project.key,
      categories: project.categories,
      customFields: project.customFields,
    });
  } catch (err) { next(err); }
});

const submitSchema = z.object({
  name: z.string().min(1).max(200),
  email: z.string().email(),
  title: z.string().min(1).max(500),
  description: z.string().default(''),
  priority: z.enum(['critical', 'high', 'medium', 'low']).default('medium'),
  category: z.string().optional(),
  subcategory: z.string().optional(),
  customFields: z.record(z.unknown()).default({}),
});

// POST /portal/:token/requests — submit a ticket
router.post('/:token/requests', submitLimiter, async (req, res, next) => {
  try {
    const project = await findProjectByToken(req.params['token'] as string);
    if (!project?.portalEnabled) { next(Errors.notFound('Portal')); return; }

    const body = submitSchema.parse(req.body);
    const email = body.email.toLowerCase();

    // Find or create a guest user for this email in the org.
    let [user] = await db.select().from(users)
      .where(eq(users.email, email)).limit(1);

    if (!user) {
      const [org] = await db.select({ settings: organizations.settings })
        .from(organizations).where(eq(organizations.id, project.orgId)).limit(1);
      const settings = (org?.settings ?? {}) as OrganizationSettings;
      const roleId = await builtinGlobalRoleId(project.orgId,
        settings.autoProvisionRole ?? 'customer');
      [user] = await db.insert(users).values({
        orgId: project.orgId,
        email,
        name: body.name,
        globalRole: 'customer',
        roleId,
      }).returning();
    }

    if (!user) { next(Errors.internal()); return; }

    const { request, projectKey } = await createRequest({
      projectId: project.id,
      requesterId: user.id,
      title: body.title,
      description: body.description,
      priority: body.priority,
      category: body.category,
      subcategory: body.subcategory,
      customFields: body.customFields,
    });

    res.status(201).json({
      id: request.id,
      ticketNumber: request.ticketNumber,
      ticketRef: `${projectKey}-${request.ticketNumber}`,
      title: request.title,
      status: request.status,
    });
  } catch (err) { next(err); }
});

export { router as portalRouter };
