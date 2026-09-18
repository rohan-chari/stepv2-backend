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
        ASYNC_RACE_RESOLUTION_CONCURRENCY: "3",
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
test(
  "real HTTP worker avoids empty intent reads and combines snapshot/task completion",
  { timeout: 45000 },
  async () => {
    await cleanDatabase();
    await prisma.appSetting.upsert({
      where: { key: "raceResolutionPostTasksV1Enabled" },
      create: { key: "raceResolutionPostTasksV1Enabled", value: true },
      update: { value: true },
    });
    const race = await makeRace();
    await upload(race);
    const w = worker();
    try {
      await waitFor(() => taskReceipt(race));
      const receipt = await taskReceipt(race);
      assert.equal(receipt.intentCount, 0);
      assert.equal(receipt.terminalState, "succeeded");
      assert.equal(receipt.snapshotState, "succeeded");
      const queries = w.messages
        .filter((m) => m.kind === "query")
        .map((m) => m.query);
      const lists = queries.filter(
        (q) =>
          q.includes("FROM race_resolution_delivery_intents") &&
          q.includes("ORDER BY ordinal ASC"),
      );
      const recoveries = queries.filter(
        (q) =>
          q.includes("UPDATE race_resolution_delivery_intents intent") &&
          q.includes("last_error_code='LEASE_RECOVERY'"),
      );
      const standalone = queries.filter((q) =>
        q.includes("SET snapshot_state=$2, snapshot_error_code=$3"),
      );
      console.log(
        JSON.stringify({
          experiment: "empty post task",
          queries: queries.length,
          intentLists: lists.length,
          recoveryUpdates: recoveries.length,
          standaloneCompletions: standalone.length,
        }),
      );
      assert.equal(lists.length, 0, "empty task needs no separate intent list");
      assert.equal(recoveries.length, 0, "empty task needs no recovery update");
      assert.equal(
        standalone.length,
        0,
        "snapshot and receipt terminalize together",
      );
      const res = await request(
        server.baseUrl,
        "GET",
        `/races/${race.id}/progress`,
        { token: race.user.token, headers: { "X-Timezone": "UTC" } },
      );
      assert.equal(res.status, 200);
      assert.equal(
        (await res.json()).progress.participants.find(
          (p) => p.userId === race.user.user.id,
        ).totalSteps,
        100,
      );
    } finally {
      require("node:fs").writeFileSync("/tmp/post-task-worker.log", w.logs());
      await w.stop();
    }
  },
);
for (const attempting of [false, true])
  test(
    `real worker handles intents despite stale zero count: attempting=${attempting}`,
    { timeout: 45000 },
    async () => {
      await cleanDatabase();
      const race = await makeRace();
      const now = new Date();
      const key = require("node:crypto")
        .createHash("sha256")
        .update(randomUUID())
        .digest("hex");
      const task = await prisma.raceResolutionPostTask.create({
        data: {
          raceId: race.id,
          sourceGeneration: 1,
          dedupeKey: `v1:post-delivery:${race.id}:1`,
          requestedAt: now,
          notBeforeAt: now,
          snapshotCommand: { raceId: race.id, timeZone: "UTC" },
          payloadBytes: 100,
          intentCount: 0,
        },
      });
      const intent = await prisma.raceResolutionDeliveryIntent.create({
        data: {
          taskId: task.id,
          ordinal: 0,
          kind: "STATE_NOTIFICATION",
          recipientUserId: null,
          payload: {},
          payloadBytes: 2,
          deliveryKeyHash: key,
          state: attempting ? "attempting" : "pending",
          attemptId: attempting ? "old-attempt" : null,
        },
      });
      const w = worker();
      try {
        await waitFor(() => taskReceipt(race));
        const receipt = await taskReceipt(race);
        assert.equal(receipt.terminalState, "succeeded_with_failures");
        assert.equal(receipt.failureCount, 1);
        const row = await prisma.raceResolutionDeliveryIntent.findUnique({
          where: { id: intent.id },
        });
        assert.equal(
          row.state,
          attempting ? "ambiguous_at_most_once" : "rejected_no_retry",
        );
        assert.ok(
          await prisma.raceResolutionDeliveryIntentReceipt.findUnique({
            where: { deliveryKeyHash: key },
          }),
          "delivery receipt persists",
        );
      } finally {
        await w.stop();
      }
    },
  );

test(
  "real worker recovers an expired empty task without retrying an attempted snapshot",
  { timeout: 45000 },
  async () => {
    await cleanDatabase();
    const race = await makeRace();
    const past = new Date(Date.now() - 60000);
    const task = await prisma.raceResolutionPostTask.create({
      data: {
        raceId: race.id,
        sourceGeneration: 1,
        dedupeKey: `v1:post-delivery:${race.id}:1`,
        state: "running",
        leaseToken: "dead-worker",
        leaseExpiresAt: past,
        requestedAt: past,
        notBeforeAt: past,
        snapshotState: "attempting",
        snapshotAttemptId: "old-attempt",
        snapshotAttemptedAt: past,
        snapshotCommand: { raceId: race.id, timeZone: "UTC" },
        payloadBytes: 100,
        intentCount: 0,
      },
    });
    const w = worker();
    try {
      await waitFor(() => taskReceipt(race));
      const receipt = await taskReceipt(race);
      assert.equal(receipt.terminalState, "succeeded_with_failures");
      assert.equal(receipt.snapshotState, "ambiguous_at_most_once");
      const row = await prisma.raceResolutionPostTask.findUnique({
        where: { id: task.id },
      });
      assert.equal(row.snapshotAttemptId, "old-attempt");
      assert.equal(row.snapshotErrorCode, "LEASE_RECOVERY");
      assert.equal(
        w.messages.filter((m) => m.query?.includes("snapshot_attempt_id=$3"))
          .length,
        0,
        "recovered attempted snapshot is never republished",
      );
    } finally {
      await w.stop();
    }
  },
);

test(
  "receipt collision rolls back combined snapshot and task completion",
  { timeout: 45000 },
  async () => {
    await cleanDatabase();
    const race = await makeRace();
    const now = new Date(),
      key = `v1:post-delivery:${race.id}:1`;
    const task = await prisma.raceResolutionPostTask.create({
      data: {
        raceId: race.id,
        sourceGeneration: 1,
        dedupeKey: key,
        requestedAt: now,
        notBeforeAt: now,
        snapshotCommand: { raceId: race.id, timeZone: "UTC" },
        payloadBytes: 100,
        intentCount: 0,
      },
    });
    const original = await prisma.raceResolutionPostTaskReceipt.create({
      data: {
        raceId: race.id,
        sourceGeneration: 1,
        dedupeKey: key,
        terminalState: "succeeded",
        snapshotState: "succeeded",
        intentCount: 0,
        failureCount: 0,
        completedAt: new Date(+now - 60000),
      },
    });
    const w = worker();
    try {
      await waitFor(() =>
        w.logs().includes("post-task receipt immutable identity mismatch"),
      );
      const row = await prisma.raceResolutionPostTask.findUnique({
        where: { id: task.id },
      });
      assert.equal(row.state, "running");
      assert.equal(row.completedAt, null);
      assert.equal(row.snapshotState, "attempting");
      assert.equal(
        row.snapshotCompletedAt,
        null,
        "snapshot completion rolls back with task receipt collision",
      );
      assert.deepEqual(await taskReceipt(race), original);
    } finally {
      await w.stop();
    }
  },
);
