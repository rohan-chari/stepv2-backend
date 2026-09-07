process.env.SESSION_TOKEN_SECRET = "integration-only-memory-profile-secret";
// Reproducible, real-worker profile. Run unchanged on the baseline and candidate
// against a dedicated local *_test DB; PROFILE lines are evidence, not budgets.
process.env.PRISMA_QUERY_EVENTS_ENABLED = "true";
process.env.RACE_QUEUE_V2_QUIET_PERIOD_MS = "0";
process.env.RACE_RESOLVE_DEBOUNCE_MS = "0";
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { before, beforeEach, it } = require("node:test");
const { prisma, cleanDatabase, createTestUser, getSharedServer, request } = require("./setup");
const { buildRaceResolutionWorkerV2 } = require("../../src/modules/races/jobs/raceResolutionQueueV2");
let baseUrl, capture;
prisma.$on("query", event => capture?.push({ query: event.query, duration: event.duration }));
before(async () => { baseUrl = (await getSharedServer()).baseUrl; });
beforeEach(cleanDatabase);
for (const historyPerParticipant of [0, 12]) it(`profiles 40 runners across three queued races with ${historyPerParticipant} historical effects each`, async () => {
  const accounts = [];
  for (let i = 0; i < 40; i++) accounts.push(await createTestUser());
  const day = new Date(); day.setUTCDate(day.getUTCDate() - 2); day.setUTCHours(0, 0, 0, 0);
  const races = [];
  for (const hour of [2, 1, 3]) {
    const race = await prisma.race.create({ data: { creatorId: accounts[0].user.id, name: `Memory profile ${hour}`,
      status: "ACTIVE", targetSteps: 1000000, powerupsEnabled: true, timezone: "UTC", maxParticipants: 100,
      startedAt: new Date(+day + hour * 3600000), endsAt: new Date(Date.now() + 86400000) } });
    await prisma.raceParticipant.createMany({ data: accounts.map(a => ({ raceId: race.id, userId: a.user.id,
      status: "ACCEPTED", joinedAt: race.startedAt })) });
    const participants = await prisma.raceParticipant.findMany({ where: { raceId: race.id } });
    const powerups = [], effects = [];
    for (const p of participants) for (let i = 0; i < historyPerParticipant; i++) {
      const id = randomUUID();
      powerups.push({ id, raceId: race.id, participantId: p.id, userId: p.userId,
        type: "RUNNERS_HIGH", rarity: "RARE", status: "USED", earnedAtSteps: i + 1 });
      // Distinct historical windows before these samples: all must be loaded
      // and fenced, but none should alter the samples' expected scores.
      effects.push({ raceId: race.id, targetParticipantId: p.id, targetUserId: p.userId,
        sourceUserId: p.userId, powerupId: id, type: "RUNNERS_HIGH", status: "EXPIRED",
        startsAt: new Date(+race.startedAt + i * 60000), expiresAt: new Date(+race.startedAt + (i + 1) * 60000), metadata: { multiplier: 2 } });
    }
    if (powerups.length) {
      await prisma.racePowerup.createMany({ data: powerups });
      await prisma.raceActiveEffect.createMany({ data: effects });
    }
    races.push(race);
  }
  for (const a of accounts) {
    const response = await request(baseUrl, "POST", "/steps/sync-v2", { token: a.token,
      headers: { "Idempotency-Key": randomUUID(), "X-Timezone": "UTC" },
      body: { date: day.toISOString().slice(0, 10), steps: 300,
        samples: [10, 11, 12].map(hour => ({ periodStart: new Date(+day + hour * 3600000).toISOString(),
          periodEnd: new Date(+day + (hour + 1) * 3600000).toISOString(), steps: 100 })) } });
    assert.equal(response.status, 202, JSON.stringify(await response.json()));
  }
  const queries = [], logs = []; capture = queries;
  const start = performance.now();
  try {
    const worker = buildRaceResolutionWorkerV2({ bootAt: 0,
      logger: { log: value => { try { logs.push(JSON.parse(value)); } catch {} }, warn() {}, error: console.error } });
    for (const race of races) await worker.processRace({ raceId: race.id });
  } finally { capture = null; }
  const elapsedMs = performance.now() - start;
  for (let i = 0; i < races.length; i++) {
    const rows = await prisma.raceParticipant.findMany({ where: { raceId: races[i].id } });
    assert.equal(rows.length, 40);
    assert.ok(rows.every(p => p.totalSteps === 300), "all worker-persisted scores must match");
    const response = await request(baseUrl, "GET", `/races/${races[i].id}/progress`, { token: accounts[0].token });
    assert.equal(response.status, 200);
  }
  const completed = logs.filter(x => x.event === "race_resolution_v2");
  console.log("MEMORY_PROFILE " + JSON.stringify({ historyPerParticipant, participants: 40, races: 3,
    queries: queries.length, summedQueryDurationMs: queries.reduce((n, q) => n + q.duration, 0), elapsedMs,
    sampleReads: queries.filter(q => q.query.includes("WITH requested AS MATERIALIZED") && q.query.includes("JOIN step_samples sample")).length,
    raceLoadQueries: completed.reduce((n, x) => n + (x.computePhaseQueryCount?.raceLoad || 0), 0),
    scoringPrefetchQueries: completed.reduce((n, x) => n + (x.computePhaseQueryCount?.scoringPrefetch || 0), 0),
    fenceRejections: completed.reduce((n, x) => n + x.closureFenceRejections + x.sourceInputFenceRejections, 0) }));
});
it("profiles a day of five-minute samples with only one changed interval", async () => {
  const account = await createTestUser();
  const day = new Date(); day.setUTCDate(day.getUTCDate() - 2); day.setUTCHours(0, 0, 0, 0);
  const samples = Array.from({ length: 288 }, (_, i) => ({
    periodStart: new Date(+day + i * 300000).toISOString(),
    periodEnd: new Date(+day + (i + 1) * 300000).toISOString(), steps: 5,
  }));
  async function upload(rows) {
    const response = await request(baseUrl, "POST", "/steps/sync-v2", { token: account.token,
      headers: { "Idempotency-Key": randomUUID(), "X-Timezone": "UTC" },
      body: { date: day.toISOString().slice(0, 10), steps: rows.reduce((sum, row) => sum + row.steps, 0), samples: rows } });
    assert.equal(response.status, 202, JSON.stringify(await response.json()));
  }
  await upload(samples);
  const before = await prisma.$queryRawUnsafe('SELECT id,xmin::text FROM step_samples WHERE user_id=$1', account.user.id);
  const versions = new Map(before.map(row => [row.id, row.xmin]));
  const queries = []; capture = queries; const start = performance.now();
  try { await upload(samples.map((row, i) => ({ ...row, steps: i === 287 ? 6 : row.steps }))); }
  finally { capture = null; }
  const elapsedMs = performance.now() - start;
  const after = await prisma.$queryRawUnsafe('SELECT id,xmin::text,steps FROM step_samples WHERE user_id=$1 ORDER BY period_start', account.user.id);
  assert.equal(after.length, 288);
  assert.ok(after.slice(0, 287).every(row => row.steps === 5));
  assert.equal(after[287].steps, 6);
  console.log("MEMORY_INTAKE_PROFILE " + JSON.stringify({ samples: 288,
    submittedTuples: queries.filter(q => q.query.includes("INSERT INTO step_samples"))
      .reduce((sum, q) => sum + (q.query.match(/gen_random_uuid\(\)/g) || []).length, 0),
    changedPhysicalRows: after.filter(row => versions.get(row.id) !== row.xmin).length,
    queries: queries.length, summedQueryDurationMs: queries.reduce((sum, q) => sum + q.duration, 0), elapsedMs }));
});
