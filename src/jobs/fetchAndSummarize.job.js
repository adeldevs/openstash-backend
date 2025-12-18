const cron = require('node-cron');

const ArticleSummary = require('../models/ArticleSummary');
const { connectToMongo } = require('../config/db');
const { env, validateEnv } = require('../config/env');
const { fetchAllFeeds } = require('../services/rss/fetchFeeds');
const { extractArticle } = require('../services/extract/articleExtractor');
const { summarizeWithGemini } = require('../services/gemini/summarize');
const { sha256 } = require('../services/utils/hash');
const { normalizeUrl, domainFromUrl } = require('../services/utils/url');
const { formatErrorForLog } = require('../services/utils/safeError');

let isRunning = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientMongoError(err) {
  const name = String(err?.name || '');
  const msg = String(err?.message || '').toLowerCase();

  return (
    name.includes('ServerSelectionError') ||
    name.includes('NetworkTimeoutError') ||
    msg.includes('replicasetnoprimary') ||
    msg.includes('server selection timed out') ||
    msg.includes('timed out')
  );
}

async function withMongoRetry(fn, label) {
  const maxAttempts = Number.parseInt(process.env.MONGODB_OP_RETRIES || '3', 10);
  const baseDelayMs = Number.parseInt(process.env.MONGODB_OP_RETRY_DELAY_MS || '750', 10);

  let lastErr;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await connectToMongo(env.MONGODB_URI);
      // eslint-disable-next-line no-await-in-loop
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransientMongoError(err)) throw err;

      const waitMs = baseDelayMs * attempt;
      console.warn(
        `Mongo transient error during ${label} (attempt ${attempt}/${maxAttempts}). Retrying in ${waitMs}ms...`
      );
      if (attempt < maxAttempts) {
        // eslint-disable-next-line no-await-in-loop
        await sleep(waitMs);
      }
    }
  }

  throw lastErr;
}

function isRateLimitOrQuotaErrorMessage(message) {
  const msg = String(message || '').toLowerCase();
  return (
    msg.includes('429') ||
    msg.includes('too many requests') ||
    msg.includes('quota') ||
    msg.includes('503') ||
    msg.includes('service unavailable') ||
    msg.includes('overloaded') ||
    msg.includes('fetch failed') ||
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('timed out')
  );
}

function parsePublishedAt(item) {
  const raw = item.isoDate || item.pubDate || item.published || item.date;
  if (!raw) return undefined;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return undefined;
  return d;
}

function pickAuthor(item) {
  return item.creator || item.author || item['dc:creator'] || undefined;
}

async function upsertLastSeen(urlHash) {
  await withMongoRetry(
    () =>
      ArticleSummary.updateOne(
        { 'dedupe.urlHash': urlHash },
        { $set: { lastSeenAt: new Date() } }
      ),
    'updateOne(lastSeenAt)'
  );
}

async function processFeedItem({ feedUrl, feedTitle }, item) {
  const rawLink = item.link;
  if (!rawLink) return;

  const normalizedUrl = normalizeUrl(rawLink);
  const urlHash = sha256(normalizedUrl);
  const guid = item.guid || item.id;
  const guidHash = guid ? sha256(String(guid)) : undefined;

  const existing = await withMongoRetry(
    () => ArticleSummary.findOne({ 'dedupe.urlHash': urlHash }).select('_id'),
    'findOne(existing)'
  );
  if (existing) {
    await upsertLastSeen(urlHash);
    return { didSummarize: false };
  }

  const author = pickAuthor(item);
  const title = item.title || normalizedUrl;
  const publishedAt = parsePublishedAt(item);

  const doc = await withMongoRetry(
    () =>
      ArticleSummary.create({
        title,
        author,
        url: normalizedUrl,
        guid,
        feed: { feedUrl, title: feedTitle },
        source: { domain: domainFromUrl(normalizedUrl) },
        publishedAt,
        lastSeenAt: new Date(),
        dedupe: { urlHash, guidHash },
        status: 'new',
      }),
    'create(ArticleSummary)'
  );

  try {
    const extracted = await extractArticle(normalizedUrl);

    const fallbackText = (item.contentSnippet || item.content || '').toString();
    const rawText = extracted?.text || fallbackText;

    if (!rawText || rawText.trim().length < 200) {
      doc.status = 'failed';
      doc.errors.push({ stage: 'extract', message: 'Not enough extractable text' });
      await withMongoRetry(() => doc.save(), 'save(extract-too-short)');
      return { didSummarize: false };
    }

    doc.content = {
      excerpt: extracted?.excerpt || item.contentSnippet,
      rawText,
      wordCount: rawText.split(/\s+/).filter(Boolean).length,
      imageUrl: extracted?.imageUrl,
    };
    doc.status = 'extracted';
    await withMongoRetry(() => doc.save(), 'save(extracted)');

    doc.status = 'summarizing';
    await withMongoRetry(() => doc.save(), 'save(summarizing)');

    const summaryJson = await summarizeWithGemini({
      author,
      title: extracted?.title || title,
      url: normalizedUrl,
      text: rawText,
    });

    doc.title = summaryJson.title || doc.title;
    doc.author = summaryJson.author || doc.author;
    doc.summary = {
      version: 1,
      points: summaryJson.points.map((p) => {
        const bullets = Array.isArray(p.bullets)
          ? p.bullets.map((b) => String(b).trim()).filter(Boolean)
          : [];
        const paragraph = typeof p.paragraph === 'string' ? p.paragraph.trim() : undefined;
        return {
          heading: String(p.heading).trim(),
          bullets,
          paragraph,
        };
      }),
    };

    doc.llm = doc.llm || {};
    doc.llm.model = summaryJson._model || env.GEMINI_MODEL;
    doc.llm.generatedAt = new Date();
    doc.status = 'summarized';

    await withMongoRetry(() => doc.save(), 'save(summarized)');

    console.log(`Summarized: ${normalizedUrl} (points: ${doc.summary.points.length}, model: ${doc.llm.model})`);

    if (env.GEMINI_MIN_DELAY_MS > 0) {
      await sleep(env.GEMINI_MIN_DELAY_MS);
    }

    return { didSummarize: true };
  } catch (err) {
    const message = String(err.message || 'Unknown error').slice(0, 2000);
    // Rate limit/quota errors should be retried later; don't mark permanently failed.
    if (isRateLimitOrQuotaErrorMessage(message)) {
      doc.status = 'extracted';
    } else {
      doc.status = 'failed';
    }

    doc.errors.push({ stage: 'summarize', message });
    try {
      await withMongoRetry(() => doc.save(), 'save(summarize-error)');
    } catch (saveErr) {
      console.error('Failed to persist summarize error to Mongo:', formatErrorForLog(saveErr));
    }

    return { didSummarize: false };
  }
}

async function retryExtractedSummaries() {
  const pending = await withMongoRetry(
    () =>
      ArticleSummary.find(
        {
          status: { $in: ['extracted', 'failed'] },
          'summary.points.0': { $exists: false },
          'content.rawText': { $exists: true },
        },
        {
          title: 1,
          author: 1,
          url: 1,
          content: 1,
          errors: 1,
          llm: 1,
          summary: 1,
          status: 1,
        }
      )
        .sort({ updatedAt: 1 })
        .limit(env.RETRY_EXTRACTED_LIMIT),
    'find(pending-retries)'
  );

  if (pending.length > 0) {
    console.log(`Retrying ${pending.length} extracted/failed summaries...`);
  }

  let attempted = 0;

  for (const doc of pending) {
    if (attempted >= env.MAX_SUMMARIES_PER_RUN) break;
    attempted += 1;

    try {
      // eslint-disable-next-line no-await-in-loop
      console.log(`Summarizing (retry): ${doc.url}`);

      doc.status = 'summarizing';
      // eslint-disable-next-line no-await-in-loop
      await withMongoRetry(() => doc.save(), 'save(retry-summarizing)');

      const summaryJson = await summarizeWithGemini({
        author: doc.author,
        title: doc.title,
        url: doc.url,
        text: doc.content?.rawText || '',
      });

      doc.summary = {
        version: 1,
        points: summaryJson.points.map((p) => {
          const bullets = Array.isArray(p.bullets)
            ? p.bullets.map((b) => String(b).trim()).filter(Boolean)
            : [];
          const paragraph = typeof p.paragraph === 'string' ? p.paragraph.trim() : undefined;
          return { heading: String(p.heading).trim(), bullets, paragraph };
        }),
      };

      doc.llm = doc.llm || {};
      doc.llm.model = summaryJson._model || env.GEMINI_MODEL;
      doc.llm.generatedAt = new Date();
      doc.status = 'summarized';
      await withMongoRetry(() => doc.save(), 'save(retry-summarized)');

      console.log(`Summarized (retry): ${doc.url} (points: ${doc.summary.points.length}, model: ${doc.llm.model})`);

      if (env.GEMINI_MIN_DELAY_MS > 0) {
        // eslint-disable-next-line no-await-in-loop
        await sleep(env.GEMINI_MIN_DELAY_MS);
      }
    } catch (err) {
      const message = String(err.message || 'Unknown error').slice(0, 2000);
      console.error(`Summarize failed (retry): ${doc.url} :: ${message}`);
      doc.errors = Array.isArray(doc.errors) ? doc.errors : [];
      doc.errors.push({ stage: 'summarize', message });
      try {
        // eslint-disable-next-line no-await-in-loop
        await withMongoRetry(() => doc.save(), 'save(retry-summarize-error)');
      } catch (saveErr) {
        console.error('Failed to persist retry error to Mongo:', formatErrorForLog(saveErr));
      }
      if (isRateLimitOrQuotaErrorMessage(message)) break;
    }
  }
}

async function runOnce() {
  if (isRunning) {
    console.log('Fetch job already running; skipping.');
    return;
  }

  isRunning = true;
  try {
    validateEnv();
    await connectToMongo(env.MONGODB_URI);
    console.log('Starting RSS fetch + summarize job...');

    await retryExtractedSummaries();

    const feeds = await fetchAllFeeds(env.RSS_FEED_URLS);

    let summarizedThisRun = 0;

    for (const result of feeds) {
      const { feedUrl, feed, error } = result;
      if (error) {
        const msg = String(error?.message || error || '').slice(0, 400);
        console.error(`Feed fetch failed: ${feedUrl} :: ${msg}`);
        continue;
      }

      const items = Array.isArray(feed.items) ? feed.items.slice(0, env.MAX_ITEMS_PER_FEED) : [];
      for (const item of items) {
        if (summarizedThisRun >= env.MAX_SUMMARIES_PER_RUN) break;
        // eslint-disable-next-line no-await-in-loop
        const result = await processFeedItem({ feedUrl, feedTitle: feed.title }, item);
        if (result?.didSummarize) summarizedThisRun += 1;
      }
    }

    console.log('RSS fetch + summarize job complete.');
  } catch (err) {
    console.error('Job error:', formatErrorForLog(err));
  } finally {
    isRunning = false;
  }
}

function startScheduler() {
  cron.schedule(env.FETCH_CRON, () => {
    runOnce().catch((err) => console.error('Job error:', formatErrorForLog(err)));
  });

  if (env.RUN_ON_STARTUP) {
    runOnce().catch((err) => console.error('Job error:', formatErrorForLog(err)));
  }

  console.log(`Scheduler active (cron: ${env.FETCH_CRON}).`);
}

module.exports = { startScheduler, runOnce };
