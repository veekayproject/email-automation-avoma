import { app } from './app.js';
import { config } from './config.js';

const server = app.listen(config.PORT, () => {
  console.log(`FollowPilot is running at ${config.APP_BASE_URL}`);
  if (config.demoMode) console.log('Demo mode is enabled; no external messages will be sent.');
});

const shutdown = () => server.close(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
