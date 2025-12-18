function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function parseIntEnv(name, defaultValue) {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value)) return defaultValue;
  return value;
}

function parseBoolEnv(name, defaultValue) {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(raw).toLowerCase());
}

function parseCsvEnv(name, defaultValue) {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const env = {
  PORT: parseIntEnv('PORT', 3000),
  MONGODB_URI: process.env.MONGODB_URI,

  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  GEMINI_MODEL: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
  GEMINI_FALLBACK_MODEL: process.env.GEMINI_FALLBACK_MODEL || 'gemini-2.5-flash-lite',
  GEMINI_MAX_RETRIES: parseIntEnv('GEMINI_MAX_RETRIES', 3),
  GEMINI_MIN_DELAY_MS: parseIntEnv('GEMINI_MIN_DELAY_MS', 1200),

  RSS_FEED_URLS: parseCsvEnv('RSS_FEED_URLS', [
    'https://news.ycombinator.com/rss',
    'http://feeds.arstechnica.com/arstechnica/index/',
    'https://www.theguardian.com/uk/rss',
    'https://lwn.net/headlines/newrss',
    'http://feeds.reuters.com/Reuters/worldNews',
    'http://feeds.bbci.co.uk/news/video_and_audio/news_front_page/rss.xml',
  ]),

  FETCH_CRON: process.env.FETCH_CRON || '0 0 * * *',
  RUN_ON_STARTUP: parseBoolEnv('RUN_ON_STARTUP', true),
  MAX_ITEMS_PER_FEED: parseIntEnv('MAX_ITEMS_PER_FEED', 10),
  MAX_SUMMARIES_PER_RUN: parseIntEnv('MAX_SUMMARIES_PER_RUN', 30),
  RETRY_EXTRACTED_LIMIT: parseIntEnv('RETRY_EXTRACTED_LIMIT', 30),
  HTTP_TIMEOUT_MS: parseIntEnv('HTTP_TIMEOUT_MS', 20000),
  RSS_FETCH_RETRIES: parseIntEnv('RSS_FETCH_RETRIES', 2),
  RSS_FETCH_RETRY_DELAY_MS: parseIntEnv('RSS_FETCH_RETRY_DELAY_MS', 1200),
};

function validateEnv() {
  requireEnv('MONGODB_URI');
  requireEnv('GEMINI_API_KEY');
}

module.exports = { env, validateEnv };
