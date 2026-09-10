#!/usr/bin/env node
// Reset and seed are separate commits, each with awaited cache invalidation.
const path = require('node:path');
require('dotenv').config();
const { runSqlPhase } = require('./review-cache-maintenance');
const { seedReviewDemo } = require('./seed-app-review-demo');
(async () => {
  await runSqlPhase('review-reset', path.join(__dirname, 'reset-app-review.sql'));
  await seedReviewDemo();
  console.log('Review state reset, seed and cache invalidation complete.');
})().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(async () => {
  await require('../src/shared/cache/redisCache').close();
  await require('../src/db').prisma.$disconnect();
      process.exit(process.exitCode || 0);
});
