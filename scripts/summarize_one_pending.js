require('dotenv').config();

const mongoose = require('mongoose');

const ArticleSummary = require('../src/models/ArticleSummary');
const { summarizeWithGemini } = require('../src/services/gemini/summarize');

async function main() {
  if (!process.env.MONGODB_URI) throw new Error('Missing MONGODB_URI');

  await mongoose.connect(process.env.MONGODB_URI);

  const doc = await ArticleSummary.findOne({
    status: { $in: ['extracted', 'failed'] },
    'content.rawText': { $exists: true },
    $or: [{ 'summary.points.0': { $exists: false } }, { summary: { $exists: false } }],
  }).sort({ updatedAt: 1 });

  if (!doc) {
    console.log('No pending docs found.');
    await mongoose.disconnect();
    return;
  }

  console.log('Picked:', doc._id.toString());
  console.log('URL:', doc.url);
  console.log('WordCount:', doc.content?.wordCount);

  const summary = await summarizeWithGemini({
    author: doc.author,
    title: doc.title,
    url: doc.url,
    text: doc.content.rawText,
  });

  doc.summary = {
    version: 1,
    points: summary.points.map((p) => ({
      heading: String(p.heading).trim(),
      bullets: Array.isArray(p.bullets) ? p.bullets.map((b) => String(b).trim()).filter(Boolean) : [],
      paragraph: typeof p.paragraph === 'string' ? p.paragraph.trim() : undefined,
    })),
  };

  doc.llm.model = summary._model || process.env.GEMINI_MODEL;
  doc.llm.generatedAt = new Date();
  doc.status = 'summarized';
  await doc.save();

  console.log('Saved points:', doc.summary.points.length);
  console.log('Model:', doc.llm.model);

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
