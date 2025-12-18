const mongoose = require('mongoose');
const ArticleSummary = require('../models/ArticleSummary');

function parsePositiveInt(value, defaultValue, maxValue) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) return defaultValue;
  if (maxValue && parsed > maxValue) return maxValue;
  return parsed;
}

async function listSummaries(req, res, next) {
  try {
    const page = parsePositiveInt(req.query.page, 1);
    const limit = parsePositiveInt(req.query.limit, 20, 100);
    const skip = (page - 1) * limit;

    const sort = { publishedAt: -1, ingestedAt: -1 };

    const [items, total] = await Promise.all([
      ArticleSummary.find({}, {
        title: 1,
        author: 1,
        url: 1,
        feed: 1,
        source: 1,
        publishedAt: 1,
        ingestedAt: 1,
        content: { imageUrl: 1 },
        summary: 1,
      })
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .lean(),
      ArticleSummary.countDocuments(),
    ]);

    const hasNext = skip + items.length < total;

    res.json({
      items,
      pageInfo: { page, limit, total, hasNext },
    });
  } catch (err) {
    next(err);
  }
}

async function getSummaryById(req, res, next) {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: 'Invalid id' });
    }

    const includeRaw = ['1', 'true', 'yes'].includes(String(req.query.includeRaw || '').toLowerCase());

    const projection = includeRaw
      ? undefined
      : {
          'content.rawText': 0,
        };

    const doc = await ArticleSummary.findById(id, projection).lean();
    if (!doc) return res.status(404).json({ message: 'Not found' });

    res.json(doc);
  } catch (err) {
    next(err);
  }
}

module.exports = { listSummaries, getSummaryById };
