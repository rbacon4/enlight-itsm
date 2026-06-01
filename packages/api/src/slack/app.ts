import { App, LogLevel } from '@slack/bolt';
import { logger } from '../lib/logger.js';

let _slackApp: App | null = null;

export function getSlackApp(): App {
  if (!_slackApp) throw new Error('Slack app not initialized');
  return _slackApp;
}

export function isSlackRunning(): boolean {
  return _slackApp !== null;
}

export function clearSlackApp(): void {
  _slackApp = null;
}

export interface SlackTokenConfig {
  botToken: string;
  signingSecret: string;
  appToken?: string;
}

export function createSlackApp(config: SlackTokenConfig): App {
  const isProduction = process.env['NODE_ENV'] === 'production';

  _slackApp = new App({
    token: config.botToken,
    signingSecret: config.signingSecret,
    socketMode: !isProduction,
    ...(config.appToken ? { appToken: config.appToken } : {}),
    logLevel: process.env['LOG_LEVEL'] === 'debug' ? LogLevel.DEBUG : LogLevel.WARN,
    logger: {
      debug: (...msgs) => logger.debug(msgs.join(' ')),
      info: (...msgs) => logger.info(msgs.join(' ')),
      warn: (...msgs) => logger.warn(msgs.join(' ')),
      error: (...msgs) => logger.error(msgs.join(' ')),
      setLevel: () => {},
      getLevel: () => LogLevel.INFO,
      setName: () => {},
    },
  });

  return _slackApp;
}
