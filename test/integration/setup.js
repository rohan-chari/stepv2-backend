const http = require("node:http");
const { prisma } = require("../../src/db");
const { createApp } = require("../../src/app");
const { signSessionToken } = require("../../src/modules/users/services/sessionToken");

// Tables in deletion order (respects foreign key constraints)
const TABLES_IN_ORDER = [
  // Keep this complete and child-to-parent ordered. TRUNCATE ... CASCADE walks
  // the whole FK graph and takes AccessExclusive locks on every discovered
  // table/index; on the local integration DB that turned an empty cleanup into
  // a 20s operation after the feature-batch tables were added.
  "inbox_delivery_outbox",
  "analytics_cleanup_runs",
  "metric_coverage_starts",
  "admin_metrics_collection_epochs",
  "inbox_alerts",
  "feedback_messages",
  "feedback_threads",
  "app_review_prompt_attempts",
  "global_event_user_summaries",
  "global_event_race_impacts",
  "global_step_event_operational_snapshots",
  "global_step_event_operational_counters",
  "global_step_event_cron_owners",
  "global_step_event_entitlements",
  "race_effect_impacts",
  "race_impact_events",
  "race_umbrella_interceptions",
  "active_race_effect_impacts",
  "active_race_impact_work",
  "race_payout_double_offer_items",
  "race_payout_double_offers",
  "race_payout_double_velocity_grants",
  "race_payout_double_claim_receipts",
  "race_payout_double_identities",
  "race_resolution_delivery_intents",
  "race_resolution_post_tasks",
  "race_resolution_jobs_v2",
  "race_resolution_jobs",
  "race_messages",
  "race_powerup_events",
  "race_active_effects",
  "race_powerups",
  "seeded_race_window_memberships",
  "seeded_race_bucket_assignments",
  "race_participants",
  "seeded_race_buckets",
  "seeded_race_window_modes",
  "ranked_cohort_members",
  "season_scores",
  "tournament_participants",
  "tournaments",
  "tournament_seeds",
  "races",
  "powerup_purchase_requests",
  "user_powerup_items",
  "shop_purchase_requests",
  "step_milestone_claims",
  "daily_reward_claims",
  "user_equipped_accessories",
  "user_shop_items",
  "shop_items",
  "coin_transactions",
  "ad_reward_grants",
  "activation_events",
  "user_activity_days",
  "push_deliveries",
  "device_tokens",
  "stakes",
  "challenge_instances",
  "weekly_challenges",
  "challenges",
  "step_samples",
  "steps",
  "friendships",
  "friendship_auto_link_suppressions",
  "friend_search_rate_windows",
  "step_sync_requests",
  "user_scoring_input_versions",
  "referral_reward_grants",
  "referrals",
  "notifications",
  "link_opens",
  "suggestions",
  "global_step_events",
  "users",
  // Standalone (no FK to users) — the marketing site's Android waitlist.
  "android_waitlist_entries",
];

// Refuse to truncate anything that is not obviously a throwaway database.
//
// This is a blast-radius guard, not a test behaviour: `cleanDatabase` deletes
// the users table and its dependent rows, so pointing DATABASE_URL at the wrong
// host for one command is unrecoverable. The allowed names are the ones the
// project uses for disposable databases: a `*-integration` legacy DB or any
// `*_test` DB (what `npm run test:integration` now creates).
//
// Deliberately checks the DB NAME rather than the host: a prod URL copied into
// the environment fails here even if it happens to be reachable locally.
function assertDisposableDatabase() {
  const url = process.env.DATABASE_URL || "";
  let name = "";
  try {
    // Strip query params and leading slash; tolerate URLs the parser rejects.
    name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
  } catch {
    name = url.split("/").pop()?.split("?")[0] || "";
  }
  if (!/-integration$|_test$/.test(name)) {
    throw new Error(
      `cleanDatabase() refused to modify: DATABASE_URL database is "${name || "(unset)"}", ` +
        `which does not end in "-integration" or "_test". ` +
        `Integration tests must never run against a real database — ` +
        `use \`npm run test:integration\`, which points at steps-tracker-integration_test.`
    );
  }
}

async function cleanDatabase() {
  assertDisposableDatabase();
  // TRUNCATE rewrites every relation and index. On the local disposable
  // Postgres volume that is ~25 seconds even when the tables are empty, because
  // this suite has a broad FK graph. Test fixtures create only small row sets,
  // so ordered DELETEs are dramatically cheaper while preserving the same
  // isolation (all primary keys are UUIDs; no sequence reset is required).
  const tableLiterals = TABLES_IN_ORDER.map(
    (table) => `'${table.replace(/'/g, "''")}'`
  ).join(", ");
  // One server-side block rather than one Prisma round trip per table: the
  // latter can exceed Prisma's default 5s interactive-transaction timeout on
  // a busy local adapter pool.
  await prisma.$executeRawUnsafe(`
    DO $$
    DECLARE table_name text;
    BEGIN
      FOREACH table_name IN ARRAY ARRAY[${tableLiterals}]
      LOOP
        EXECUTE format('DELETE FROM %I', table_name);
      END LOOP;
    END $$;
  `);
}

async function startServer(dependencies = {}) {
  const app = createApp(dependencies);
  const server = http.createServer(app);

  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

async function createTestUser(overrides = {}) {
  const user = await prisma.user.create({
    data: {
      appleId: overrides.appleId || `apple-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      email: overrides.email || `test-${Date.now()}@example.com`,
      displayName: overrides.displayName || null,
      ...overrides,
    },
  });

  const token = signSessionToken({
    userId: user.id,
    appleId: user.appleId,
  });

  return { user, token };
}

function request(baseUrl, method, path, { body, token, headers } = {}) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function disconnectDatabase() {
  await prisma.$disconnect();
}

// Shared server singleton — all test files reuse the same server
let sharedServer = null;

async function getSharedServer() {
  if (!sharedServer) {
    sharedServer = await startServer({
      verifyAppleIdentityToken: async (token) => ({
        sub: token,
        email: `${token}@example.com`,
      }),
    });

  }
  return sharedServer;
}

function getBaseUrl() {
  return sharedServer?.baseUrl;
}

module.exports = {
  prisma,
  cleanDatabase,
  disconnectDatabase,
  startServer,
  createTestUser,
  request,
  getBaseUrl,
  getSharedServer,
};
