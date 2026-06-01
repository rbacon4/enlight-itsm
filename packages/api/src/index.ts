import 'dotenv/config';
import { app } from './app.js';
import { startSlack } from './slack/index.js';
import { logLicenseStatus } from './lib/license.js';
import { logger } from './lib/logger.js';

const PORT = parseInt(process.env['PORT'] ?? '3000', 10);

logLicenseStatus();

app.listen(PORT, () => {
  logger.info(`Enlight API running on port ${PORT}`);
});

startSlack().catch((err) => {
  logger.error('Slack startup failed', { err });
});
