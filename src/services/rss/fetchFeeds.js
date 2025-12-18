const Parser = require('rss-parser');
const axios = require('axios');

const { env } = require('../../config/env');

const parser = new Parser();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function truncateMessage(message, max = 400) {
  const s = String(message || '');
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

function isTransientFetchError(err) {
  const msg = String(err?.message || '').toLowerCase();
  const code = String(err?.code || '').toLowerCase();
  const status = err?.response?.status;

  if (status && status >= 500) return true;
  if (status === 429) return true;

  return (
    msg.includes('timeout') ||
    msg.includes('timed out') ||
    msg.includes('econnreset') ||
    msg.includes('socket hang up') ||
    msg.includes('fetch failed') ||
    code === 'etimedout' ||
    code === 'econnreset' ||
    code === 'enotfound'
  );
}

async function fetchFeed(feedUrl) {
  const maxAttempts = Math.max(1, (env.RSS_FETCH_RETRIES || 0) + 1);

  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      // Fetch XML ourselves so we can control timeout/retries and avoid rss-parser dumping
      // massive HTML pages into error messages when a feed URL returns HTML.
      const res = await axios.get(feedUrl, {
        timeout: env.HTTP_TIMEOUT_MS,
        maxRedirects: 5,
        responseType: 'text',
        headers: {
          'User-Agent': 'BackEndExpress-RSS-Summarizer/1.0',
          Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.1',
        },
        transformResponse: (r) => r,
        validateStatus: (status) => status >= 200 && status < 400,
      });

      const xml = typeof res.data === 'string' ? res.data : String(res.data || '');
      if (!xml || xml.trim().length === 0) {
        throw new Error('Empty RSS response');
      }

      return await parser.parseString(xml);
    } catch (err) {
      lastErr = err;
      if (!isTransientFetchError(err) || attempt === maxAttempts) {
        const status = err?.response?.status;
        const msg = truncateMessage(err?.message || err);
        const e = new Error(status ? `HTTP ${status}: ${msg}` : msg);
        e.cause = err;
        throw e;
      }

      const waitMs = (env.RSS_FETCH_RETRY_DELAY_MS || 1200) * attempt;
      // eslint-disable-next-line no-await-in-loop
      await sleep(waitMs);
    }
  }

  throw lastErr;
}

async function fetchAllFeeds(feedUrls) {
  const results = [];

  for (const feedUrl of feedUrls) {
    try {
      const feed = await fetchFeed(feedUrl);
      results.push({ feedUrl, feed, error: null });
    } catch (error) {
      results.push({ feedUrl, feed: null, error });
    }
  }

  return results;
}

module.exports = { fetchAllFeeds };
