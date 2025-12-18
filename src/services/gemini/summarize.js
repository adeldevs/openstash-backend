const { GoogleGenerativeAI } = require('@google/generative-ai');

const { env } = require('../../config/env');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryDelayMs(message) {
  if (!message) return null;
  const match = String(message).match(/Please retry in\s+([0-9.]+)s/i);
  if (!match) return null;
  const seconds = Number.parseFloat(match[1]);
  if (Number.isNaN(seconds) || seconds <= 0) return null;
  return Math.ceil(seconds * 1000);
}

function isRateLimitOrQuotaError(err) {
  const msg = String(err?.message || '').toLowerCase();
  return msg.includes('429') || msg.includes('too many requests') || msg.includes('quota');
}

function isTransientGeminiError(err) {
  const msg = String(err?.message || '').toLowerCase();
  return (
    isRateLimitOrQuotaError(err) ||
    msg.includes('503') ||
    msg.includes('service unavailable') ||
    msg.includes('overloaded') ||
    msg.includes('fetch failed') ||
    msg.includes('econnreset') ||
    msg.includes('etimedout')
  );
}

function buildPrompt({ author, title, url, text }) {
  const clipped = text.length > 15000 ? text.slice(0, 15000) : text;

  return [
    'You are an expert news summarizer.',
    'Return ONLY valid JSON. Do not wrap in markdown. Do not include backticks.',
    'Output schema:',
    '{',
    '  "author": string|null,',
    '  "title": string,',
    '  "url": string,',
    '  "points": [',
    '    { "heading": string, "bullets"?: string[], "paragraph"?: string }',
    '  ]',
    '}',
    'Rules:',
    '- points MUST contain exactly 10 items.',
    '- Each point must have a short heading and either (a) 2-5 bullets OR (b) one concise paragraph.',
    '- Bullets must be factual, concise, and derived from the article text.',
    '- No speculation, no ads, no CTAs.',
    '',
    `Author: ${author || ''}`,
    `Title: ${title || ''}`,
    `URL: ${url}`,
    '',
    'Article text:',
    clipped,
  ].join('\n');
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    // Try to salvage JSON object from surrounding text
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) return null;
    const slice = text.slice(start, end + 1);
    try {
      return JSON.parse(slice);
    } catch {
      return null;
    }
  }
}

function validateSummaryJson(json) {
  if (!json || typeof json !== 'object') return null;
  if (!json.title || !json.url || !Array.isArray(json.points)) return null;
  if (json.points.length !== 10) return null;
  for (const p of json.points) {
    if (!p || typeof p.heading !== 'string') return null;
    const hasBullets = Array.isArray(p.bullets) && p.bullets.length > 0;
    const hasParagraph = typeof p.paragraph === 'string' && p.paragraph.trim().length > 0;
    if (!hasBullets && !hasParagraph) return null;
  }
  return json;
}

async function generateOnce({ modelName, prompt }) {
  const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: modelName });
  const result = await model.generateContent(prompt);
  return result.response.text();
}

async function summarizeWithGemini({ author, title, url, text }) {
  const prompt = buildPrompt({ author, title, url, text });

  const modelCandidates = Array.from(
    new Set([env.GEMINI_MODEL, env.GEMINI_FALLBACK_MODEL].filter(Boolean))
  );

  let lastErr;

  for (const modelName of modelCandidates) {
    for (let attempt = 0; attempt <= env.GEMINI_MAX_RETRIES; attempt += 1) {
      try {
        const outputText = await generateOnce({ modelName, prompt });

        const parsed = validateSummaryJson(safeJsonParse(outputText));
        if (!parsed) {
          const err = new Error('Gemini did not return valid summary JSON');
          err.details = { outputText: outputText.slice(0, 2000), modelName };
          throw err;
        }

        parsed._model = modelName;
        return parsed;
      } catch (err) {
        lastErr = err;

        if (!isTransientGeminiError(err)) break;

        const waitMs =
          parseRetryDelayMs(err.message) || Math.min(30000, 2000 * 2 ** Math.max(0, attempt));
        await sleep(waitMs);
      }
    }
  }

  throw lastErr || new Error('Gemini request failed');
}

module.exports = { summarizeWithGemini };
