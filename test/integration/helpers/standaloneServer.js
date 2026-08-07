// Test-only: boot a SECOND, genuinely separate API process against the same
// Postgres + Redis, and print `LISTENING <baseUrl>` on stdout.
//
// Why a real child process: `createApp()` twice inside one test process shares
// every module singleton (the appSettings/balanceConfig in-process caches, the
// redisCache subscriber), so a "two instance" test built that way would pass
// even with no pub/sub at all. Cross-worker invalidation (spec §3, §8 test 3)
// is only provable across process boundaries.
//
// Deliberately does NOT start any cron/worker (`src/index.js`'s schedulers) —
// this process only serves HTTP, so it can never become a second bulk writer.
const http = require("node:http");

const { createApp } = require("../../../src/app");

const app = createApp({
  // Same stub the shared test harness uses, so `POST /auth/apple` works here.
  verifyAppleIdentityToken: async (token) => ({
    sub: token,
    email: `${token}@example.com`,
  }),
});

const server = http.createServer(app);
server.listen(Number(process.env.PORT || 0), "127.0.0.1", () => {
  const { port } = server.address();
  process.stdout.write(`LISTENING http://127.0.0.1:${port}\n`);
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
