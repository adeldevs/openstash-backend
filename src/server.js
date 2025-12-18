require('dotenv').config();

// Helps on some Windows + IPv6/DNS setups with MongoDB Atlas.
require('node:dns').setDefaultResultOrder('ipv4first');

const { createApp } = require('./app');
const { connectToMongo } = require('./config/db');
const { env, validateEnv } = require('./config/env');
const { startScheduler } = require('./jobs/fetchAndSummarize.job');
const { formatErrorForLog } = require('./services/utils/safeError');

async function start() {
  validateEnv();
  await connectToMongo(env.MONGODB_URI);

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    console.log(`Server listening on port ${env.PORT}`);
  });

  startScheduler();

  return server;
}

start().catch((err) => {
  console.error('Fatal startup error:', formatErrorForLog(err));
  process.exit(1);
});
