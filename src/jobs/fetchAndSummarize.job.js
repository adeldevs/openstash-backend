// List of valid categories
const VALID_CATEGORIES = [
  // Science & Technology
  'Acoustics','Aerospace Engineering','Agronomy','Artificial Intelligence','Astronomy','Astrophysics','Automation','Bioinformatics','Biotechnology','Blockchain','Botany','Chemical Engineering','Civil Engineering','Cloud Computing','Computer Vision','Consumer Electronics','Cryptography','Cybersecurity','Data Science','Ecology','Electrical Engineering','Entomology','Epidemiology','Evolutionary Biology','Forensic Science','Game Development','Genetics','Geology','Hacking','Hydrology','Immunology','Information Technology','Internet of Things (IoT)','Machine Learning','Marine Biology','Materials Science','Mechanical Engineering','Meteorology','Microbiology','Nanotechnology','Neuroscience','Nuclear Physics','Oceanography','Optics','Organic Chemistry','Paleontology','Particle Physics','Pharmacology','Quantum Mechanics','Robotics','Software Engineering','Space Exploration','Sustainability','Telecommunications','Thermodynamics','Toxicology','Virtual Reality (VR)','Web Development','Zoology',
  // Humanities & Social Sciences
  'Anthropology','Archaeology','Cognitive Science','Criminology','Demography','Developmental Psychology','Epistemology','Ethics','Ethnography','Gender Studies','Genealogy','Geography','Geopolitics','History (Ancient, Medieval, Modern)','Human Rights','International Relations','Law (Constitutional, Corporate, Criminal)','Linguistics','Logic','Media Studies','Metaphysics','Military History','Mythology','Pedagogy','Philosophy','Political Science','Psychology (Clinical, Social, Behavioral)','Public Administration','Religious Studies','Social Work','Sociology','Theology','Urban Planning',
  // Business & Economics
  'Accounting','Advertising','Behavioral Economics','Branding','Business Ethics','Corporate Governance','Cryptocurrency','Digital Marketing','E-commerce','Entrepreneurship','Finance (Personal, Corporate)','Human Resources','Industrial Relations','Insurance','International Trade','Investing','Logistics','Macroeconomics','Management','Microeconomics','Operations Management','Project Management','Real Estate','Sales','Stock Market','Supply Chain Management','Taxation','Venture Capital',
  // Arts, Culture & Media
  'Animation','Architecture','Art History','Calligraphy','Cinematography','Creative Writing','Culinary Arts','Dance','Design (Graphic, Industrial, Interior)','Fashion','Film Studies','Fine Arts','Journalism','Literature','Music Theory','Performing Arts','Photography','Poetry','Pop Culture','Publishing','Sculpture','Stand-up Comedy','Television','Textile Design','Theater','Video Games','Visual Arts',
  // Health, Lifestyle & Sports
  'Alternative Medicine','Athletic Training','Biohacking','Dental Hygiene','Dermatology','Dietetics','Emergency Medicine','Ergonomics','Fitness','Gastronomy','Geriatrics','Holistic Health','Kinesiology','Meditation','Mental Health','Minimalism','Nursing','Nutrition','Occupational Therapy','Parenting','Pediatrics','Personal Development','Physical Therapy','Productivity','Psychiatry','Public Health','Sports Management','Sports Psychology','Sports Science','Survivalism','Travel & Tourism','Veterinary Medicine','Wellness','Yoga',
  // Niche & Miscellaneous
  'Astrology','Aviation','Bibliophilia','Carpentry','Chess','Collecting (Philately, Numismatics)','Conspiracy Theories','Cryptozoology','DIY & Making','Esotericism','Etiquette','Futurism','Gardening','Genealogy','Horticulture','Magic (Illusion)','Maritime Studies','Military Strategy','Numismatics','Occultism','Parapsychology','Philanthropy','Survival Skills','Transhumanism','True Crime','Vexillology (Flags)','Miscellaneous'
];

function getValidCategories(categories) {
  if (!Array.isArray(categories)) return ['Miscellaneous'];
  // Normalize and filter
  return categories
    .map((c) => String(c).trim())
    .filter((c) => VALID_CATEGORIES.includes(c))
    .filter((v, i, arr) => arr.indexOf(v) === i) // unique
    .slice(0, 5); // limit to 5 categories max
}
const cron = require('node-cron');

const ArticleSummary = require('../models/ArticleSummary');
const JobState = require('../models/JobState');
const { connectToMongo } = require('../config/db');
const { env, validateEnv } = require('../config/env');
const { fetchAllFeeds } = require('../services/rss/fetchFeeds');
const { extractArticle } = require('../services/extract/articleExtractor');
const { summarizeWithGemini } = require('../services/gemini/summarize');
const { sha256 } = require('../services/utils/hash');
const { normalizeUrl, domainFromUrl } = require('../services/utils/url');
const { formatErrorForLog } = require('../services/utils/safeError');

let isRunning = false;

const DAILY_GEMINI_JOB_KEY = 'daily-gemini-fetch-and-summarize';
const DAILY_JOB_CRON = '0 8 * * *';
const DAILY_JOB_TIMEZONE = 'Asia/Kolkata';

function getTimeZoneParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const out = {};
  for (const p of parts) {
    if (p.type !== 'literal') out[p.type] = p.value;
  }

  return {
    year: out.year,
    month: out.month,
    day: out.day,
    hour: Number.parseInt(out.hour, 10),
    minute: Number.parseInt(out.minute, 10),
  };
}

function toDateKeyInTimeZone(date, timeZone) {
  const { year, month, day } = getTimeZoneParts(date, timeZone);
  return `${year}-${month}-${day}`;
}

function isEightAmInTimeZone(date, timeZone) {
  const { hour } = getTimeZoneParts(date, timeZone);
  return hour === 8;
}

async function tryAcquireDailyRun(now) {
  const today = toDateKeyInTimeZone(now, DAILY_JOB_TIMEZONE);

  const updated = await withMongoRetry(
    () =>
      JobState.findOneAndUpdate(
        { key: DAILY_GEMINI_JOB_KEY, 'value.lastRunDate': { $ne: today } },
        {
          $set: {
            key: DAILY_GEMINI_JOB_KEY,
            'value.lastRunDate': today,
            'value.lastRunAt': now,
          },
        },
        { upsert: true, new: true }
      ),
    'findOneAndUpdate(JobState.daily-run)'
  );

  // If we didn't match (already ran today), Mongoose returns null.
  return Boolean(updated);
}

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

    // Store categories from AI output, filtered to valid list
    const validCategories = getValidCategories(summaryJson.categories);
    doc.categories = validCategories;

    doc.llm = doc.llm || {};
    doc.llm.model = summaryJson._model || env.GEMINI_MODEL;
    doc.llm.generatedAt = new Date();
    doc.status = 'summarized';

    await withMongoRetry(() => doc.save(), 'save(summarized)');

    console.log(`Summarized: ${normalizedUrl} (points: ${doc.summary.points.length}, model: ${doc.llm.model}, categories: ${doc.categories})`);

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

async function runOnce(options = {}) {
  if (isRunning) {
    console.log('Fetch job already running; skipping.');
    return;
  }

  isRunning = true;
  try {
    validateEnv();
    await connectToMongo(env.MONGODB_URI);

    const now = new Date();
    const force = Boolean(options.force);

    if (!force && !isEightAmInTimeZone(now, DAILY_JOB_TIMEZONE)) {
      console.log(
        `Skipping job: only allowed at 8 AM IST (now: ${now.toString()}).`
      );
      return;
    }

    if (!force) {
      const acquired = await tryAcquireDailyRun(now);
      if (!acquired) {
        console.log(
          `Skipping job: already ran today (${toDateKeyInTimeZone(now, DAILY_JOB_TIMEZONE)}) (IST).`
        );
        return;
      }
    }

    console.log('Starting RSS fetch + summarize job...');

    await retryExtractedSummaries();

    const feeds = await fetchAllFeeds(env.RSS_FEED_URLS);

    let summarizedThisRun = 0;
    // Collect articles to summarize
    const articlesToSummarize = [];
    const articleDocs = [];
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
        // Prepare article extraction
        const rawLink = item.link;
        if (!rawLink) continue;
        const normalizedUrl = normalizeUrl(rawLink);
        const urlHash = sha256(normalizedUrl);
        const guid = item.guid || item.id;
        const guidHash = guid ? sha256(String(guid)) : undefined;
        const existing = await withMongoRetry(() => ArticleSummary.findOne({ 'dedupe.urlHash': urlHash }).select('_id'), 'findOne(existing)');
        if (existing) {
          await upsertLastSeen(urlHash);
          continue;
        }
        const author = pickAuthor(item);
        const title = item.title || normalizedUrl;
        const publishedAt = parsePublishedAt(item);
        const doc = await withMongoRetry(() => ArticleSummary.create({
          title,
          author,
          url: normalizedUrl,
          guid,
          feed: { feedUrl, title: feed.title },
          source: { domain: domainFromUrl(normalizedUrl) },
          publishedAt,
          lastSeenAt: new Date(),
          dedupe: { urlHash, guidHash },
          status: 'new',
        }), 'create(ArticleSummary)');
        try {
          const extracted = await extractArticle(normalizedUrl);
          const fallbackText = (item.contentSnippet || item.content || '').toString();
          const rawText = extracted?.text || fallbackText;
          if (!rawText || rawText.trim().length < 200) {
            doc.status = 'failed';
            doc.errors.push({ stage: 'extract', message: 'Not enough extractable text' });
            await withMongoRetry(() => doc.save(), 'save(extract-too-short)');
            continue;
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
          articlesToSummarize.push({ author, title: extracted?.title || title, url: normalizedUrl, text: rawText });
          articleDocs.push(doc);
          summarizedThisRun += 1;
        } catch (err) {
          doc.status = 'failed';
          doc.errors.push({ stage: 'extract', message: String(err.message || 'Unknown error').slice(0, 2000) });
          await withMongoRetry(() => doc.save(), 'save(extract-error)');
        }
      }
    }

    // Batch summarize in chunks of 10
    const { summarizeBatchWithGemini } = require('../services/gemini/summarize');
    for (let i = 0; i < articlesToSummarize.length; i += 10) {
      const batch = articlesToSummarize.slice(i, i + 10);
      const docsBatch = articleDocs.slice(i, i + 10);
      try {
        const summaries = await summarizeBatchWithGemini(batch);
        for (let j = 0; j < summaries.length; j++) {
          const summaryJson = summaries[j];
          const doc = docsBatch[j];
          doc.title = summaryJson.title || doc.title;
          doc.author = summaryJson.author || doc.author;
          doc.summary = {
            version: 1,
            points: Array.isArray(summaryJson.points) ? summaryJson.points.map((p) => {
              const bullets = Array.isArray(p.bullets) ? p.bullets.map((b) => String(b).trim()).filter(Boolean) : [];
              const paragraph = typeof p.paragraph === 'string' ? p.paragraph.trim() : undefined;
              return { heading: String(p.heading).trim(), bullets, paragraph };
            }) : [],
          };
          doc.categories = getValidCategories(summaryJson.categories);
          doc.llm = doc.llm || {};
          doc.llm.model = summaryJson._model || env.GEMINI_MODEL;
          doc.llm.generatedAt = new Date();
          doc.status = 'summarized';
          await withMongoRetry(() => doc.save(), 'save(summarized)');
          console.log(`Summarized: ${doc.url} (points: ${doc.summary.points.length}, model: ${doc.llm.model}, categories: ${doc.categories})`);
        }
      } catch (err) {
        console.error('Batch summarize error:', err);
      }
      if (env.GEMINI_MIN_DELAY_MS > 0) {
        await sleep(env.GEMINI_MIN_DELAY_MS);
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
  cron.schedule(
    DAILY_JOB_CRON,
    () => {
      runOnce().catch((err) => console.error('Job error:', formatErrorForLog(err)));
    },
    { timezone: DAILY_JOB_TIMEZONE }
  );

  // Intentionally do NOT run on startup: Gemini calls must happen only at 8 AM.
  console.log(
    `Scheduler active (daily @ 8:00 AM IST; cron: ${DAILY_JOB_CRON}; tz: ${DAILY_JOB_TIMEZONE}).`
  );
}

module.exports = { startScheduler, runOnce };
