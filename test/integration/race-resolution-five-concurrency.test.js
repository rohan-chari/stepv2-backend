const assert = require("node:assert/strict");
const { before, beforeEach, it } = require("node:test");
const { randomUUID } = require("node:crypto");
const { Client } = require("pg");

process.env.ASYNC_RACE_RESOLUTION_CONCURRENCY = "5";
process.env.RACE_QUEUE_V2_QUIET_PERIOD_MS = "0";
process.env.RACE_RESOLVE_DEBOUNCE_MS = "0";
const { prisma, cleanDatabase, createTestUser, getSharedServer, request } = require("./setup");
const { buildRaceResolutionWorkerV2 } = require("../../src/modules/races/jobs/raceResolutionQueueV2");
const { raceResolutionWorkBudget } = require("../../src/modules/races/services/raceResolutionWorkBudget");
let baseUrl;
before(async () => { baseUrl = (await getSharedServer()).baseUrl; });
beforeEach(cleanDatabase);

it("five HTTP-enqueued races occupy five real worker slots and expose persisted totals", async () => {
  const accounts = [];
  for (let i = 0; i < 5; i++) {
    const account = await createTestUser();
    const now = Date.now();
    const race = await prisma.race.create({ data: {
      creatorId: account.user.id, name: `Five lanes ${i}`, status: "ACTIVE",
      targetSteps: 100000, maxParticipants: 10, powerupsEnabled: false, timezone: "UTC",
      startedAt: new Date(now - 7200000), endsAt: new Date(now + 86400000),
    } });
    await prisma.raceParticipant.create({ data: { raceId: race.id, userId: account.user.id,
      status: "ACCEPTED", joinedAt: new Date(now - 7200000) } });
    const response = await request(baseUrl, "POST", "/steps/sync-v2", {
      token: account.token, headers: { "Idempotency-Key": randomUUID(), "X-Timezone": "UTC" },
      body: { date: new Date(now).toISOString().slice(0, 10), steps: 50, samples: [{
        periodStart: new Date(now - 3600000).toISOString(),
        periodEnd: new Date(now - 1800000).toISOString(), steps: 50,
      }] },
    });
    assert.equal(response.status, 202);
    accounts.push({ ...account, raceId: race.id });
  }
  const raceIds = accounts.map(account => account.raceId);
  const blocker = new Client({ connectionString: process.env.DATABASE_URL });
  await blocker.connect();
  await blocker.query("BEGIN");
  await blocker.query("SELECT id FROM races WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE", [raceIds]);
  const ticking = buildRaceResolutionWorkerV2({ bootAt: 0 }).tick();
  try {
    await new Promise(setImmediate);
    assert.equal(raceResolutionWorkBudget.snapshot().active, 5);
    assert.equal(raceResolutionWorkBudget.snapshot().maxActive, 5);
  } finally {
    await blocker.query("ROLLBACK");
    await blocker.end();
    await ticking;
  }
  assert.equal(await ticking, 5);
  const jobs = await prisma.raceResolutionJobV2.findMany({ where: { raceId: { in: raceIds } } });
  assert.equal(jobs.length, 5);
  assert.ok(jobs.every(row => row.lastCompletedAt));
  assert.equal(raceResolutionWorkBudget.snapshot().active, 0);
  for (const account of accounts) {
    const response = await request(baseUrl, "GET", `/races/${account.raceId}/progress`, { token: account.token });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.progress.participants.find(row => row.userId === account.user.id).totalSteps, 50);
  }
});
