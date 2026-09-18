process.env.PRISMA_QUERY_EVENTS_ENABLED = "true";
const assert = require("node:assert/strict");
const { test, after } = require("node:test");
const { spawn } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");
const path = require("node:path");
const { prisma, cleanDatabase, createTestUser, getSharedServer, request } = require("./setup");
const database = new URL(process.env.DATABASE_URL);
assert.ok(["localhost", "127.0.0.1"].includes(database.hostname));
assert.match(database.pathname, /_test$/);
let server;
after(async () => { if (server) await server.close(); });
for (const empty of [false, true]) test(`real worker shares overlapping ${empty ? "empty" : "nonempty"} user sources across three races`, { timeout: 90000 }, async () => {
  await cleanDatabase();
  const account = await createTestUser({ timezone: "UTC" });
  const now = Date.now(), startedAt = new Date(now - 7200000);
  const races = [];
  for (let i = 0; i < 3; i++) {
    const race = await prisma.race.create({ data: { creatorId: account.user.id, name: `Sharing race ${i}`, status: "ACTIVE",
      targetSteps: 100000, maxParticipants: 10, powerupsEnabled: true, timezone: "UTC",
      startedAt, endsAt: new Date(now + 86400000) } });
    await prisma.raceParticipant.create({ data: { raceId: race.id, userId: account.user.id, status: "ACCEPTED", joinedAt: startedAt } });
    races.push(race);
  }
  server ||= await getSharedServer();
  const upload = await request(server.baseUrl, "POST", "/steps/sync-v2", { token: account.token,
    headers: { "Idempotency-Key": require("node:crypto").randomUUID(), "X-Timezone": "UTC" },
    body: { date: new Date(now).toISOString().slice(0,10), steps: empty ? 0 : 321, samples: empty ? [] : [{
      periodStart: new Date(now - 3600000).toISOString(), periodEnd: new Date(now - 1800000).toISOString(), steps: 321,
    }] } });
  assert.equal(upload.status, 202);
  const root = process.env.EVENT_EFFICIENCY_CODE_ROOT || path.resolve(__dirname, "../..");
  const child = spawn(process.execPath, ["--require", path.resolve(__dirname, "fixtures/event-efficiency/observe-source-loads.cjs"), path.join(root, "src/index.js")], {
    cwd: root, env: { ...process.env, NODE_ENV: "test", STEPS_PROCESS_ROLE: "resolution", NODE_APP_INSTANCE: "0", PORT: "0",
      CRON_START_DELAY_MS: "0", RACE_QUEUE_V2_QUIET_PERIOD_MS: "0", ASYNC_RACE_RESOLUTION_CONCURRENCY: "3" },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const messages = []; let logs = "";
  child.on("message", message => messages.push(message));
  child.stdout.on("data", data => { logs += data; }); child.stderr.on("data", data => { logs += data; });
  try {
    let done = [];
    const until = Date.now() + 60000;
    while (Date.now() < until) {
      assert.equal(child.exitCode, null, logs.slice(-4000));
      done = await prisma.raceResolutionJobV2.findMany({ where: { raceId: { in: races.map(r => r.id) } } });
      if (done.length === 3 && done.every(job => job.committedGeneration >= 1)) break;
      await delay(100);
    }
    assert.ok(done.length === 3 && done.every(job => job.committedGeneration >= 1), logs.slice(-5000));
    const reads = messages.filter(message => message.kind === "source-start");
    assert.equal(reads.length, process.env.EVENT_EFFICIENCY_CODE_ROOT ? 3 : 1, `three concurrent compatible sources: ${logs.slice(-1000)}`);
    for (const race of races) {
      const response = await request(server.baseUrl, "GET", `/races/${race.id}/progress`, { token: account.token });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.progress.participants.find(p => p.userId === account.user.id).totalSteps, empty ? 0 : 321);
    }
    const fingerprints = messages.filter(m => m.query?.includes("WITH race_window AS"));
    assert.ok(fingerprints.length >= 6, "each race keeps planning and commit fingerprints");
    console.log(JSON.stringify({ scenario: "singleflight", empty, sourceSelects: reads.length, committedRaces: done.length, fingerprints: fingerprints.length }));
  } finally {
    if (child.exitCode === null) { child.kill("SIGTERM"); await new Promise(resolve => child.once("exit", resolve)); }
  }
});
