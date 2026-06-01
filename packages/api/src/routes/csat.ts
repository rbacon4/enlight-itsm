/**
 * CSAT (customer satisfaction) survey endpoints.
 *
 * GET  /csat/:token        — returns survey info (project name, ticket title) for the form
 * POST /csat/:token        — record the 1–5 rating + optional comment
 *
 * Surveys are created automatically when a ticket is resolved (see notifier.ts).
 * One survey per request — duplicate submissions are silently rejected.
 */
import { Router } from 'express';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { csatSurveys, requests, projects } from '../db/schema.js';
import { Errors } from '../lib/errors.js';

const router = Router();

// GET /csat/:token — public, no auth
router.get('/:token', async (req, res, next) => {
  try {
    const [survey] = await db
      .select({
        id: csatSurveys.id,
        respondedAt: csatSurveys.respondedAt,
        requestTitle: requests.title,
        requestTicketNumber: requests.ticketNumber,
        projectName: projects.name,
        projectKey: projects.key,
      })
      .from(csatSurveys)
      .innerJoin(requests, eq(requests.id, csatSurveys.requestId))
      .innerJoin(projects, eq(projects.id, requests.projectId))
      .where(eq(csatSurveys.token, req.params['token'] as string))
      .limit(1);

    if (!survey) { next(Errors.notFound('Survey')); return; }
    res.json(survey);
  } catch (err) { next(err); }
});

// POST /csat/:token — record rating
router.post('/:token', async (req, res, next) => {
  try {
    const body = z.object({
      rating:  z.number().int().min(1).max(5),
      comment: z.string().max(2000).optional(),
    }).parse(req.body);

    const [survey] = await db
      .select({ id: csatSurveys.id, respondedAt: csatSurveys.respondedAt })
      .from(csatSurveys)
      .where(eq(csatSurveys.token, req.params['token'] as string))
      .limit(1);

    if (!survey) { next(Errors.notFound('Survey')); return; }

    // Silently ignore duplicate submissions.
    if (survey.respondedAt) { res.json({ alreadyResponded: true }); return; }

    await db.update(csatSurveys)
      .set({ rating: body.rating, comment: body.comment ?? null, respondedAt: new Date() })
      .where(eq(csatSurveys.id, survey.id));

    res.json({ recorded: true });
  } catch (err) { next(err); }
});

export { router as csatRouter };
