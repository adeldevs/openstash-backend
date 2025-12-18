const mongoose = require('mongoose');

const SummaryPointSchema = new mongoose.Schema(
  {
    heading: { type: String, required: true },
    bullets: { type: [String], default: [] },
    paragraph: { type: String },
  },
  { _id: false }
);

const ArticleSummarySchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    author: { type: String },
    url: { type: String, required: true },
    guid: { type: String },

    feed: {
      feedUrl: { type: String, required: true },
      title: { type: String },
    },

    source: {
      domain: { type: String, index: true },
    },

    publishedAt: { type: Date },
    ingestedAt: { type: Date, required: true, default: Date.now },
    lastSeenAt: { type: Date },

    content: {
      excerpt: { type: String },
      rawText: { type: String },
      wordCount: { type: Number },
      imageUrl: { type: String },
    },

    summary: {
      version: { type: Number, required: true, default: 1 },
      points: { type: [SummaryPointSchema], required: true, default: [] },
    },

    llm: {
      provider: { type: String, required: true, default: 'gemini' },
      model: { type: String },
      promptVersion: { type: String, required: true, default: 'v1' },
      generatedAt: { type: Date },
    },

    dedupe: {
      urlHash: { type: String, required: true, index: true, unique: true },
      guidHash: { type: String, index: true },
    },

    status: {
      type: String,
      enum: ['new', 'extracted', 'summarizing', 'summarized', 'failed'],
      required: true,
      default: 'new',
      index: true,
    },

    errors: {
      type: [
        {
          stage: { type: String },
          message: { type: String },
          at: { type: Date, default: Date.now },
        },
      ],
      default: [],
    },
  },
  { timestamps: true, suppressReservedKeysWarning: true }
);

ArticleSummarySchema.index({ publishedAt: -1 });

module.exports = mongoose.model('ArticleSummary', ArticleSummarySchema);
