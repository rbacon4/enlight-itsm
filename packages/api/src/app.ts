import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { authRouter } from './routes/auth.js';
import { orgRouter } from './routes/org.js';
import { projectsRouter } from './routes/projects.js';
import { requestsRouter } from './routes/requests.js';
import { knowledgeRouter } from './routes/knowledge.js';
import { usersRouter } from './routes/users.js';
import { dashboardRouter } from './routes/dashboard.js';
import { analyticsRouter } from './routes/analytics.js';
import { samlAuthRouter, samlMetadataRouter } from './routes/saml.js';
import { scimRouter } from './routes/scim.js';
import { automationsRouter } from './routes/automations.js';
import { oncallRouter } from './routes/oncall.js';
import { offboardingRouter } from './routes/offboarding.js';
import { rolesRouter } from './routes/roles.js';
import { webhooksRouter } from './routes/webhooks.js';
import { portalRouter } from './routes/portal.js';
import { totpRouter } from './routes/totp.js';
import { templatesRouter } from './routes/templates.js';
import { csatRouter } from './routes/csat.js';
import { errorHandler } from './middleware/errorHandler.js';
import { mountSlackHttp } from './slack/index.js';
import { isLicensingEnabled } from './lib/license.js';

const isProduction = process.env['NODE_ENV'] === 'production';
const app = express();

// CSP is disabled because in production this same server also serves the built
// SPA (hashed assets + data: brand logos); other helmet protections stay on.
app.use(helmet({ contentSecurityPolicy: false }));
app.use(
  cors({
    origin: process.env['WEB_URL'] ?? 'http://localhost:5173',
    credentials: true,
  }),
);

// Slack webhooks need the raw request body for signature verification, so the
// Slack HTTP receiver (production only) is mounted BEFORE the JSON body parser.
// In development Slack uses Socket Mode and this is a no-op.
mountSlackHttp(app);

app.use(express.json({ limit: '10mb' }));
// SAML POST bindings (ACS) send application/x-www-form-urlencoded bodies.
app.use(express.urlencoded({ extended: false, limit: '2mb' }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// Health check (unauthenticated; never swallowed by the SPA fallback)
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', version: '1.0.0' });
});

// ── API routes ───────────────────────────────────────────────────────────────
// Mounted at the root in development (the Vite dev server proxies /api → '' to
// the backend). In production the SPA is served from this same origin, and
// several SPA routes (/projects, /users, /analytics, /offboarding) collide with
// API routes — so the whole API is mounted under /api.
const api = express.Router();

// Public feature-flag config the SPA reads on load (no auth — safe, non-secret).
api.get('/config', (_req, res) => {
  res.json({ licensingEnabled: isLicensingEnabled() });
});

api.use('/auth/saml', samlAuthRouter);
api.use('/saml', samlMetadataRouter);
api.use('/scim/v2', scimRouter);
api.use('/auth', authRouter);
api.use('/org', orgRouter);
api.use('/dashboard', dashboardRouter);
api.use('/analytics', analyticsRouter);
api.use('/users', usersRouter);
api.use('/offboarding', offboardingRouter);
api.use('/roles', rolesRouter);
api.use('/org/webhooks', webhooksRouter);
api.use('/auth/totp', totpRouter);
api.use('/projects', projectsRouter);
api.use('/projects/:projectId/requests', requestsRouter);
api.use('/projects/:projectId/knowledge', knowledgeRouter);
api.use('/projects/:projectId/automations', automationsRouter);
api.use('/projects/:projectId/oncall',     oncallRouter);
api.use('/projects/:projectId/templates', templatesRouter);

app.use(isProduction ? '/api' : '/', api);

// Public unauthenticated routes
app.use('/portal', portalRouter);
app.use('/csat',   csatRouter);

// ── Static SPA (production single-container) ─────────────────────────────────
if (isProduction) {
  const webDist =
    process.env['WEB_DIST_DIR'] ||
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
  app.use(express.static(webDist, { index: false }));
  // SPA fallback: serve index.html for client-side routes (anything that isn't an
  // API/slack/health path). Returns next() for those so they 404 as JSON.
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/slack') || req.path === '/health') {
      next();
      return;
    }
    res.sendFile(path.join(webDist, 'index.html'));
  });
}

// 404
app.use((_req, res) => {
  res.status(404).json({ error: 'NOT_FOUND', message: 'Route not found', statusCode: 404 });
});

app.use(errorHandler);

export { app };
