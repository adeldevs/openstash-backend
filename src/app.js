const express = require('express');
const cors = require('cors');

const summariesRouter = require('./routes/summaries.route');

function createApp() {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (req, res) => {
    res.json({ ok: true });
  });

  app.use('/api/summaries', summariesRouter);

  // Basic error handler
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.statusCode || err.status || 500;
    res.status(status).json({ message: err.message || 'Internal Server Error' });
  });

  return app;
}

module.exports = { createApp };
