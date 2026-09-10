#!/usr/bin/env node
// Idempotent review seed. Matching DATABASE_URL, REDIS_URL, CACHE_ENV_PREFIX
// and APP_REVIEW_EMAIL are required. Raw SQL runs only through this wrapper.
const path = require('node:path');
require('dotenv').config();
const { runPhase, runSqlPhase } = require('./review-cache-maintenance');
async function seedReviewDemo() {
  const email = process.env.APP_REVIEW_EMAIL;
  if (!email) throw new Error('APP_REVIEW_EMAIL is required');
  await runPhase('review-provision', client => client.query(`
    INSERT INTO users (id,apple_id,email,name,display_name,is_review_account,billing_realm,created_at)
    VALUES (gen_random_uuid()::text,'review-account-v1',$1,'AppReviewer','AppReviewer',true,'sandbox',CURRENT_TIMESTAMP)
    ON CONFLICT (apple_id) DO UPDATE SET email=EXCLUDED.email,is_review_account=true`, [email]));
  await runSqlPhase('review-seed', path.join(__dirname, 'seed-app-review-demo.sql'));
}
module.exports = { seedReviewDemo };
if (require.main === module) {
  seedReviewDemo().then(() => console.log('Review demo seed and cache invalidation complete.'))
    .catch(error => { console.error(error.message); process.exitCode = 1; })
    .finally(async () => {
      await require('../src/shared/cache/redisCache').close();
      await require('../src/db').prisma.$disconnect();
      process.exit(process.exitCode || 0);
    });
}
