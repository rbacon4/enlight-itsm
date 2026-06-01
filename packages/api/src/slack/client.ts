/**
 * Lightweight Slack Web API client helper.
 *
 * The full Bolt app (`app.ts`) is only available in the API server process.
 * The worker process (which runs agent jobs) never starts Bolt, so it cannot
 * use `isSlackRunning()` / `getSlackApp()`.  This module creates a bare
 * WebClient from whichever bot token is available — suitable for use in any
 * process (API or worker).
 */
import { WebClient } from '@slack/web-api';
import type { OrganizationSettings } from '@enlight/shared';

export function makeSlackClient(orgSettings?: OrganizationSettings): WebClient | null {
  const token =
    orgSettings?.slackBotToken ||
    process.env['SLACK_BOT_TOKEN'];

  if (!token) return null;
  return new WebClient(token);
}
