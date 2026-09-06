const assert = require("node:assert/strict");
const { before, beforeEach, it } = require("node:test");
const { randomUUID } = require("node:crypto");
const { Client } = require("pg");

process.env.ASYNC_RACE_RESOLUTION_CONCURRENCY = "3";
process.env.RACE_QUEUE_V2_QUIET_PERIOD_MS = "0";
process.env.RACE_RESOLVE_DEBOUNCE_MS = "0";
const { prisma, cleanDatabase, createTestUser, getSharedServer, request } = require("./setup");
const { buildRaceResolutionWorkerV2 } = require("../../src/modules/races/jobs/raceResolutionQueueV2");
const { raceResolutionWorkBudget } = require("../../src/modules/races/services/raceResolutionWorkBudget");
let baseUrl;
before(async () => { baseUrl = (await getSharedServer()).baseUrl; });
beforeEach(cleanDatabase);

it("three HTTP-enqueued races share three real worker slots and persist their scores", async () => {
  const raceIds = [];
  for (let i = 0; i < 3; i++) {
    const account = await createTestUser();
    const race = await prisma.race.create({ data: {
      creatorId: account.user.id, name: `Three lanes ${i}`, status: "ACTIVE",
      targetSteps: 100000, maxParticipants: 10, powerupsEnabled: false, timezone: "UTC",
      startedAt: new Date(Date.now()-7200000), endsAt: new Date(Date.now()+86400000),
    } });
    await prisma.raceParticipant.create({ data: { raceId: race.id, userId: account.user.id,
      status: "ACCEPTED", joinedAt: new Date(Date.now()-7200000) } });
    const response = await request(baseUrl, "POST", "/steps/sync-v2", {
      token: account.token, headers: { "Idempotency-Key": randomUUID(), "X-Timezone": "UTC" },
      body: { date: new Date().toISOString().slice(0,10), steps: 50, samples: [{
        periodStart: new Date(Date.now()-3600000).toISOString(),
        periodEnd: new Date(Date.now()-1800000).toISOString(), steps: 50,
      }] },
    });
    assert.equal(response.status, 202);
    raceIds.push(race.id);
  }
  // A real PostgreSQL row-lock barrier keeps the three resolutions in flight;
  // no production collaborator or scoring result is mocked.
  const blocker = new Client({ connectionString: process.env.DATABASE_URL });
  await blocker.connect();
  await blocker.query("BEGIN");
  await blocker.query("SELECT id FROM races WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE", [raceIds]);
  const worker = buildRaceResolutionWorkerV2({ bootAt: 0 });
  const ticking = worker.tick();
  try {
    await new Promise(setImmediate);
    assert.equal(raceResolutionWorkBudget.snapshot().active, 3);
    assert.equal(raceResolutionWorkBudget.snapshot().maxActive, 3);
  } finally {
    await blocker.query("ROLLBACK");
    await blocker.end();
    await ticking;
  }
  assert.equal(await ticking, 3);
  const participants = await prisma.raceParticipant.findMany({ where: { raceId: { in: raceIds } } });
  assert.equal(participants.length, 3);
  assert.deepEqual(participants.map(row => row.totalSteps), [50,50,50]);
  const jobs = await prisma.raceResolutionJobV2.findMany({ where: { raceId: { in: raceIds } } });
  assert.ok(jobs.every(row => row.lastCompletedAt));
  assert.equal(raceResolutionWorkBudget.snapshot().active, 0);
});
