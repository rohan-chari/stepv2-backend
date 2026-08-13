const http = require("node:http");
const { prisma } = require("../../src/db");
const { createApp } = require("../../src/app");
const { signSessionToken } = require("../../src/modules/users/services/sessionToken");

// Tables in deletion order (respects foreign key constraints)
const TABLES_IN_ORDER = [
  "race_payout_double_offer_items",
  "race_payout_double_offers",
  "race_payout_double_velocity_grants",
  "race_payout_double_claim_receipts",
  "race_payout_double_identities",
  "race_powerup_events",
  "race_active_effects",
  "race_powerups",
  "race_participants",
  "seeded_race_window_modes",
  "tournament_participants",
  "tournaments",
  "tournament_seeds",
  "races",
  "shop_purchase_requests",
  "step_milestone_claims",
  "daily_reward_claims",
  "user_equipped_accessories",
  "user_shop_items",
  "shop_items",
  "coin_transactions",
  "device_tokens",
  "stakes",
  "challenge_instances",
  "weekly_challenges",
  "challenges",
  "step_samples",
  "steps",
  "friendships",
  "suggestions",
  "users",
  // Standalone (no FK to users) — the marketing site's Android waitlist.
  "android_waitlist_entries",
];

// Refuse to truncate anything that is not obviously a throwaway database.
//
// This is a blast-radius guard, not a test behaviour: `cleanDatabase` TRUNCATEs
// the users table (and CASCADEs from it), so pointing DATABASE_URL at the wrong
// host for one command is unrecoverable. The allowed names are the ones the
// project already uses for disposable databases: a `*-integration` DB (what
// `npm run test:integration` creates) or any `*_test` DB.
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
      `cleanDatabase() refused to TRUNCATE: DATABASE_URL database is "${name || "(unset)"}", ` +
        `which does not end in "-integration" or "_test". ` +
        `Integration tests must never run against a real database — ` +
        `use \`npm run test:integration\`, which points at steps-tracker-integration.`
    );
  }
}

async function cleanDatabase() {
  assertDisposableDatabase();
  await prisma.$executeRawUnsafe(
    `TRUNCATE ${TABLES_IN_ORDER.map((t) => `"${t}"`).join(", ")} CASCADE`
  );
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
