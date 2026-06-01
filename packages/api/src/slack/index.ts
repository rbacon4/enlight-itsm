/**
 * Slack wiring.
 *
 *  - Development: Socket Mode (no public URL needed) via `startSlack()`.
 *  - Production:  standard HTTP receiver mounted on the main Express app via
 *    `mountSlackHttp()`, exposing /slack/events plus the OAuth install flow
 *    (/slack/install, /slack/oauth_redirect). Socket Mode is never used in prod.
 *
 * Self-hosters create a Slack app, point its Request URL at https://<host>/slack/events,
 * set the OAuth redirect to https://<host>/slack/oauth_redirect, then visit
 * https://<host>/slack/install to grant the bot — the resulting token is stored
 * (encrypted) on the organization.
 */
import type { Express } from 'express';
import { App, ExpressReceiver, LogLevel } from '@slack/bolt';
import type { App as BoltApp, Installation, InstallationQuery } from '@slack/bolt';
import { createSlackApp, clearSlackApp, isSlackRunning, type SlackTokenConfig } from './app.js';
import { registerAppHomeHandlers } from './appHome.js';
import { registerIntakeHandlers } from './intake.js';
import { registerActionHandlers } from './actions.js';
import { registerQuickActionHandlers } from './quickActions.js';
import { registerOffboardingHandlers } from './offboarding.js';
import { db } from '../db/client.js';
import { organizations } from '../db/schema.js';
import { asc, eq } from 'drizzle-orm';
import { encryptSecret, decryptSecret } from '../lib/secretCrypto.js';
import { logger } from '../lib/logger.js';

export { isSlackRunning };

/** Bot scopes requested during OAuth (mirror the Slack app's Bot Token Scopes). */
const BOT_SCOPES = [
  'app_mentions:read', 'channels:history', 'chat:write', 'commands',
  'im:history', 'im:read', 'im:write', 'users:read', 'users:read.email',
];

const isProduction = (): boolean => process.env['NODE_ENV'] === 'production';
const logLevel = process.env['LOG_LEVEL'] === 'debug' ? LogLevel.DEBUG : LogLevel.WARN;

let _runningApp: BoltApp | null = null;

function registerHandlers(app: BoltApp): void {
  registerAppHomeHandlers(app);
  registerIntakeHandlers(app);
  registerActionHandlers(app);
  registerQuickActionHandlers(app);
  registerOffboardingHandlers(app);
}

// ── Development: Socket Mode ─────────────────────────────────────────────────

export async function stopSlack(): Promise<void> {
  if (isProduction()) return; // HTTP receiver stays mounted on the Express app
  if (_runningApp) {
    try {
      await _runningApp.stop();
    } catch (_e) {
      /* connection may already be gone */
    }
    _runningApp = null;
    clearSlackApp();
  }
}

export async function startSlack(config?: Partial<SlackTokenConfig>): Promise<void> {
  if (isProduction()) return; // production uses mountSlackHttp() instead

  const botToken = config?.botToken ?? process.env['SLACK_BOT_TOKEN'];
  const signingSecret = config?.signingSecret ?? process.env['SLACK_SIGNING_SECRET'];
  const appToken = config?.appToken ?? process.env['SLACK_APP_TOKEN'];

  if (!botToken || botToken.startsWith('xoxb-...')) {
    logger.warn('Slack not configured — set SLACK_BOT_TOKEN to enable the bot');
    return;
  }

  await stopSlack();
  const app = createSlackApp({ botToken, signingSecret: signingSecret ?? '', ...(appToken ? { appToken } : {}) });
  registerHandlers(app);
  await app.start();
  _runningApp = app;
  logger.info('Slack bot started (Socket Mode — development)');
}

// ── Production: HTTP receiver + OAuth ────────────────────────────────────────

/**
 * Self-host single-org installation store: persists the Slack installation
 * (encrypted) on the one organization, and mirrors the bot token into
 * settings.slackBotToken so `makeSlackClient()` keeps working.
 */
const installationStore = {
  storeInstallation: async (installation: Installation): Promise<void> => {
    const org = await primaryOrg();
    if (!org) throw new Error('No organization exists to attach the Slack installation to.');
    const settings = { ...((org.settings as Record<string, unknown>) ?? {}) };
    settings['slackInstallation'] = encryptSecret(JSON.stringify(installation));
    const botToken = installation.bot?.token;
    if (botToken) settings['slackBotToken'] = encryptSecret(botToken);
    await db.update(organizations).set({ settings, updatedAt: new Date() }).where(eq(organizations.id, org.id));
    logger.info('Slack installation stored', { team: installation.team?.id });
  },
  fetchInstallation: async (_query: InstallationQuery<boolean>): Promise<Installation> => {
    const org = await primaryOrg();
    const blob = (org?.settings as Record<string, unknown> | undefined)?.['slackInstallation'];
    if (typeof blob !== 'string' || !blob) throw new Error('No Slack installation found.');
    return JSON.parse(decryptSecret(blob)) as Installation;
  },
  deleteInstallation: async (_query: InstallationQuery<boolean>): Promise<void> => {
    const org = await primaryOrg();
    if (!org) return;
    const settings = { ...((org.settings as Record<string, unknown>) ?? {}) };
    delete settings['slackInstallation'];
    delete settings['slackBotToken'];
    await db.update(organizations).set({ settings, updatedAt: new Date() }).where(eq(organizations.id, org.id));
  },
};

async function primaryOrg() {
  const [org] = await db.select().from(organizations).orderBy(asc(organizations.createdAt)).limit(1);
  return org;
}

/**
 * Mount the Slack HTTP receiver onto the main Express app (production only).
 * Must be called BEFORE express.json() so Slack signature verification can read
 * the raw request body. No-op in development (Socket Mode is used there).
 */
export function mountSlackHttp(expressApp: Express): void {
  if (!isProduction()) return;

  const signingSecret = process.env['SLACK_SIGNING_SECRET'];
  if (!signingSecret) {
    logger.warn('Slack HTTP receiver not mounted — SLACK_SIGNING_SECRET is not set.');
    return;
  }
  const clientId = process.env['SLACK_CLIENT_ID'];
  const clientSecret = process.env['SLACK_CLIENT_SECRET'];

  let receiver: ExpressReceiver;
  let app: BoltApp;

  if (clientId && clientSecret) {
    // OAuth distribution flow (recommended for production).
    receiver = new ExpressReceiver({
      signingSecret,
      clientId,
      clientSecret,
      stateSecret: process.env['SLACK_STATE_SECRET'] || process.env['JWT_SECRET'] || 'enlight-slack-state',
      scopes: BOT_SCOPES,
      endpoints: '/slack/events',
      installerOptions: {
        directInstall: true,
        installPath: '/slack/install',
        redirectUriPath: '/slack/oauth_redirect',
        ...(process.env['SLACK_REDIRECT_URI'] ? { redirectUri: process.env['SLACK_REDIRECT_URI'] } : {}),
      },
      installationStore,
      logLevel,
    });
    app = new App({ receiver, logLevel });
    logger.info('Slack HTTP + OAuth mounted (/slack/events, /slack/install, /slack/oauth_redirect)');
  } else {
    // Fallback: events-only with a manually-configured bot token (no OAuth).
    const botToken = process.env['SLACK_BOT_TOKEN'];
    if (!botToken) {
      logger.warn('Slack HTTP receiver not mounted — set SLACK_CLIENT_ID/SECRET (OAuth) or SLACK_BOT_TOKEN.');
      return;
    }
    receiver = new ExpressReceiver({ signingSecret, endpoints: '/slack/events', logLevel });
    app = new App({ token: botToken, receiver, logLevel });
    logger.info('Slack HTTP receiver mounted (/slack/events) with a static bot token (no OAuth).');
  }

  registerHandlers(app);
  _runningApp = app;
  expressApp.use(receiver.router);
}
