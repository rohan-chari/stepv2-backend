process.env.PRISMA_QUERY_EVENTS_ENABLED = "true";
const assert = require("node:assert/strict");
const { test, after, before } = require("node:test");
const { spawn } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");
const { randomUUID } = require("node:crypto");
const { Client } = require("pg");
const target = new URL(process.env.DATABASE_URL);
assert.ok(["localhost", "127.0.0.1"].includes(target.hostname));
assert.match(target.pathname, /_test$/);
const {
  prisma,
  cleanDatabase,
  createTestUser,
  getSharedServer,
  request,
} = require("./setup");
let server, localRedis;
before(async () => {
  localRedis = await require("./redisTestServer").startTestRedis();
  assert.ok(localRedis, "local Redis required for real durable wake delivery");
  process.env.REDIS_URL = localRedis.url;
  await require("../../src/shared/cache/redisCache").close();
});
after(async () => {
  if (server) await server.close();
  await prisma.$disconnect();
  await require("../../src/shared/cache/redisCache").close();
  if (localRedis) await localRedis.close();
});
const isClaim = (m) =>
  m.query?.includes("WITH candidate AS") &&
  m.query.includes("UPDATE race_resolution_jobs_v2 j");
function worker() {
  const messages = [];
  let logs = "";
  const child = spawn(
    process.execPath,
    [
      "--require",
      "./test/integration/fixtures/query-efficiency/observe-resolution.cjs",
      "src/index.js",
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: "test",
        STEPS_PROCESS_ROLE: "resolution",
        NODE_APP_INSTANCE: "0",
        PORT: "0",
        CRON_START_DELAY_MS: "0",
        RACE_QUEUE_V2_QUIET_PERIOD_MS: "0",
        ASYNC_RACE_RESOLUTION_CONCURRENCY: "1",
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  child.on("message", (m) => messages.push({ ...m, receivedAt: Date.now() }));
  child.stdout.on("data", (b) => (logs += b));
  child.stderr.on("data", (b) => (logs += b));
  return {
    messages,
    child,
    logs: () => logs,
    async stop() {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await new Promise((r) => child.once("exit", r));
      }
    },
  };
}
async function waitFor(predicate, timeout = 10000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await predicate()) return;
    await delay(50);
  }
  assert.fail("condition did not become true before deadline");
}
async function makeRace() {
  const user = await createTestUser({ timezone: "UTC" }),
    id = randomUUID(),
    now = new Date();
  await prisma.race.create({
    data: {
      id,
      name: "Claim efficiency",
      creatorId: user.user.id,
      status: "ACTIVE",
      targetSteps: 1000000,
      powerupsEnabled: true,
      startedAt: new Date(+now - 3600000),
      endsAt: new Date(+now + 86400000),
    },
  });
  const participant = await prisma.raceParticipant.create({
    data: {
      raceId: id,
      userId: user.user.id,
      status: "ACCEPTED",
      joinedAt: new Date(+now - 3600000),
      buyInStatus: "NONE",
    },
  });
  return { id, user, participant };
}
async function upload(race) {
  server ||= await getSharedServer();
  const now = Date.now();
  const res = await request(server.baseUrl, "POST", "/steps/samples", {
    token: race.user.token,
    headers: { "X-Timezone": "UTC" },
    body: {
      samples: [
        {
          periodStart: new Date(now - 1800000).toISOString(),
          periodEnd: new Date(now - 900000).toISOString(),
          steps: 100,
        },
      ],
    },
  });
  assert.equal(res.status, 200);
  return prisma.raceResolutionJobV2.findUnique({ where: { raceId: race.id } });
}
async function committed(race, generation) {
  const row = await prisma.raceResolutionJobV2.findUnique({
    where: { raceId: race.id },
  });
  return row?.committedGeneration >= generation;
}

const taskReceipt = (race) =>
  prisma.raceResolutionPostTaskReceipt.findFirst({
    where: { raceId: race.id },
  });

const sampleReads = (messages, userId) =>
  messages.filter(
    (m) =>
      m.query?.includes("JOIN step_samples sample") &&
      JSON.parse(JSON.parse(m.params)[0]).some(
        (bound) => bound.user_id === userId,
      ),
  );
async function addPeer(race, peer) {
  await prisma.raceParticipant.create({
    data: {
      raceId: race.id,
      userId: peer.user.id,
      status: "ACCEPTED",
      joinedAt: new Date(Date.now() - 3600000),
      buyInStatus: "NONE",
    },
  });
}
async function publicSteps(race, userId) {
  const res = await request(
    server.baseUrl,
    "GET",
    `/races/${race.id}/progress`,
    {
      token: race.user.token,
      headers: { "X-Timezone": "UTC" },
    },
  );
  assert.equal(res.status, 200);
  return (await res.json()).progress.participants.find(
    (p) => p.userId === userId,
  ).totalSteps;
}
for (const hasVersion of [true, false])
  test(
    `real worker handles empty coverage and upload invalidation: version=${hasVersion}`,
    { timeout: 60000 },
    async () => {
      await cleanDatabase();
      await prisma.appSetting.upsert({
        where: { key: "raceResolutionPostTasksV1Enabled" },
        create: { key: "raceResolutionPostTasksV1Enabled", value: true },
        update: { value: true },
      });
      const peer = await createTestUser({ timezone: "UTC" });
      if (hasVersion)
        await prisma.userScoringInputVersion.upsert({
          where: { userId: peer.user.id },
          create: { userId: peer.user.id, generation: 1 },
          update: { generation: 1 },
        });
      const first = await makeRace();
      await addPeer(first, peer);
      await upload(first);
      const second = await makeRace();
      await addPeer(second, peer);
      await upload(second);
      // Seed the persisted FULL envelope a scheduled whole-race refresh consumes.
      // Both jobs originate through HTTP; execution uses the real entrypoint.
      await prisma.raceResolutionJobV2.updateMany({
        where: { raceId: { in: [first.id, second.id] } },
        data: { dirtyReasons: ["FULL"] },
      });
      const w = worker();
      try {
        await waitFor(() => taskReceipt(first));
        await waitFor(() => taskReceipt(second));
        assert.equal(await publicSteps(first, peer.user.id), 0);
        assert.equal(await publicSteps(second, peer.user.id), 0);
        const reads = sampleReads(w.messages, peer.user.id);
        console.log(
          JSON.stringify({
            experiment: "empty coverage reuse",
            sampleReads: reads.length,
          }),
        );
        assert.equal(
          reads.length,
          hasVersion ? 1 : 2,
          "reuse empty coverage only when its input generation is known",
        );
        const beforeChange = w.messages.length;
        const changed = await upload({ ...second, user: peer });
        await waitFor(() => committed(second, changed.generation));
        assert.ok(
          sampleReads(w.messages.slice(beforeChange), peer.user.id).length > 0,
          "new scoring generation must invalidate empty coverage",
        );
        assert.equal(await publicSteps(second, peer.user.id), 100);
      } finally {
        await w.stop();
      }
    },
  );
