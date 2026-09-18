// The regression exercises real HTTP intake and the production worker process.
// Protocol observation adds a work-budget assertion; it does not mock the DB.
const observation = require('./fixtures/query-efficiency/observe-prepared-workers.cjs');
process.env.PRISMA_QUERY_EVENTS_ENABLED = "true";
const assert = require("node:assert/strict");
const { test, after } = require("node:test");
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
let server;
after(async () => {
  if (server) await server.close();
  await prisma.$disconnect();
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
      "./test/integration/fixtures/query-efficiency/observe-prepared-workers.cjs",
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
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise((resolve, reject) => {
        const killTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
        const deadline = setTimeout(() => reject(new Error('worker failed to exit after SIGKILL')), 10000);
        child.once('exit', () => { clearTimeout(killTimer); clearTimeout(deadline); resolve(); });
        child.kill('SIGTERM');
      });
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
      powerupsEnabled: false,
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

test(
  "selected statements reuse prepared plans through HTTP intake and the real worker",
  { timeout: 45000 },
  async () => {
    await cleanDatabase();
    const race = await makeRace();
    const w = worker();
    try {
      await waitFor(() => w.messages.some(isClaim));
      await delay(350);
      const startup = w.messages.filter(isClaim).length;
      console.log(
        JSON.stringify({ experiment: "empty startup claims", startup }),
      );
      assert.equal(
        startup,
        1,
        "three idle lanes must share one empty claim result within their drain",
      );
      await delay(5500);
      const idle = w.messages.filter(isClaim).length;
      assert.ok(
        idle <= 3,
        `idle recovery must not multiply empty probes by concurrency: ${idle}`,
      );
      const job = await upload(race);
      assert.ok(job);
      await waitFor(() => committed(race, job.generation));
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
      // A frozen client still reads the same total; Home uses the fifth query.
      const legacy = await request(server.baseUrl, 'GET', `/races/${race.id}/progress`, {
        token: race.user.token, headers: { 'X-Timezone': 'UTC', 'X-Client-Features': 'powerups2,powerups3,powerups4,powerups5' },
      });
      assert.equal(legacy.status, 200);
      assert.equal((await legacy.json()).progress.participants.find(p => p.userId === race.user.user.id).totalSteps, 100);
      for (let i = 0; i < 3; i++) {
        const home = await request(server.baseUrl, 'GET', '/home/race-card', { token: race.user.token });
        assert.equal(home.status, 200);
        assert.notEqual((await home.json()).globalEvent?.active, true);
      }
      await waitFor(() => ['placement-claim', 'placement-due', 'post-task-claim'].every(
        family => w.messages.some(m => m.family === family)), 12000);
      const selected = [...w.messages, ...observation.events];
      // Optional local evidence for the separate plan-reuse benchmark. Contains
      // synthetic test IDs/parameters only, never production queries.
      if (process.env.PREPARED_WORKER_EVIDENCE) {
        require('node:fs').writeFileSync(process.env.PREPARED_WORKER_EVIDENCE, JSON.stringify(selected, null, 2));
      }
      for (const family of ['resolution-claim', 'placement-claim', 'placement-due', 'post-task-claim', 'active-event-read']) {
        const queries = selected.filter(q => q.family === family);
        assert.ok(queries.length > 0, `${family} must be exercised through its real consumer`);
        assert.ok(queries.every(q => /^steps_(read|query)_v1_[a-f0-9]{48}$/.test(q.name || '')),
          `${family} must reuse a bounded named statement instead of reparsing each call`);
        const bySql = new Map();
        for (const q of queries) {
          if (bySql.has(q.query)) assert.equal(q.name, bySql.get(q.query), 'identical SQL must reuse the same name');
          bySql.set(q.query, q.name);
        }
      }
    } finally {
      await w.stop();
    }
  },
);

test(
  "prepared worker preserves future deadlines and recovers expired leases",
  { timeout: 45000 },
  async () => {
    await cleanDatabase();
    const future = await makeRace(),
      expired = await makeRace();
    const fj = await upload(future),
      ej = await upload(expired);
    const due = new Date(Date.now() + 3000);
    await prisma.raceResolutionJobV2.update({
      where: { raceId: future.id },
      data: { notBeforeAt: due },
    });
    await prisma.raceResolutionJobV2.update({
      where: { raceId: expired.id },
      data: {
        state: "RUNNING",
        leaseToken: "crashed-worker",
        leaseExpiresAt: due,
        processingGeneration: ej.generation,
      },
    });
    assert.equal(
      await committed(future, fj.generation),
      false,
      "future job is not claimed early",
    );
    assert.equal(
      await committed(expired, ej.generation),
      false,
      "live lease is not stolen",
    );
    const w = worker();
    try {
      await waitFor(
        async () =>
          (await committed(future, fj.generation)) &&
          (await committed(expired, ej.generation)),
        12000,
      );
      for (const race of [future, expired]) {
        const job = await prisma.raceResolutionJobV2.findUnique({ where: { raceId: race.id } });
        assert.ok(job.startedAt >= due, 'persisted claim time must respect the deadline/lease');
        assert.notEqual(job.leaseToken, 'crashed-worker');
      }
    } finally {
      await w.stop();
    }
  },
);

test(
  "prepared claims preserve concurrent progress while another race is blocked",
  { timeout: 45000 },
  async () => {
    await cleanDatabase();
    const first = await makeRace(),
      second = await makeRace();
    const one = await upload(first),
      two = await upload(second);
    await prisma.raceResolutionJobV2.update({
      where: { raceId: first.id },
      data: {
        requestedAt: new Date(Date.now() - 60000),
        notBeforeAt: new Date(Date.now() - 1000),
      },
    });
    const lock = new Client({ connectionString: target.toString() });
    await lock.connect();
    await lock.query("BEGIN");
    await lock.query(
      "SELECT id FROM race_participants WHERE id=$1 FOR UPDATE",
      [first.participant.id],
    );
    const w = worker();
    try {
      await waitFor(() => committed(second, two.generation), 12000);
      assert.equal(
        await committed(first, one.generation),
        false,
        "blocked race stays blocked while another race finishes",
      );
      await lock.query("ROLLBACK");
      await waitFor(() => committed(first, one.generation), 12000);
    } finally {
      await lock.query("ROLLBACK");
      await lock.end();
      await w.stop();
    }
  },
);
