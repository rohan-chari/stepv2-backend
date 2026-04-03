const http = require("node:http");
const { prisma } = require("../../src/db");
const { createApp } = require("../../src/app");
const { signSessionToken } = require("../../src/services/sessionToken");

// Tables in deletion order (respects foreign key constraints)
const TABLES_IN_ORDER = [
  "race_powerup_events",
  "race_active_effects",
  "race_powerups",
  "race_participants",
  "races",
  "coin_transactions",
  "device_tokens",
  "stakes",
  "challenge_instances",
  "weekly_challenges",
  "challenges",
  "step_samples",
  "steps",
  "friendships",
  "users",
];

async function cleanDatabase() {
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
      stepGoal: overrides.stepGoal || 10000,
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
