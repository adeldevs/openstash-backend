require('dotenv').config();

const mongoose = require('mongoose');
const ArticleSummary = require('../src/models/ArticleSummary');

async function main() {
  if (!process.env.MONGODB_URI) throw new Error('Missing MONGODB_URI');
  await mongoose.connect(process.env.MONGODB_URI);

  const summarizedCount = await ArticleSummary.countDocuments({
    status: 'summarized',
    'summary.points.9': { $exists: true },
  });

  const sample = await ArticleSummary.findOne({
    status: 'summarized',
    'summary.points.9': { $exists: true },
  })
    .sort({ updatedAt: -1 })
    .lean();

  console.log('summarizedCount=', summarizedCount);
  if (sample) {
    console.log('sampleUrl=', sample.url);
    console.log('points=', sample.summary?.points?.length);
    console.log('firstHeading=', sample.summary?.points?.[0]?.heading);
    console.log('model=', sample.llm?.model);
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
