process.env.PRISMA_QUERY_EVENTS_ENABLED = "true";
process.env.RACE_QUEUE_V2_QUIET_PERIOD_MS = "0";
process.env.RACE_RESOLVE_DEBOUNCE_MS = "0";

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { before, beforeEach, it } = require("node:test");
const { prisma, cleanDatabase, createTestUser, getSharedServer, request } = require("./setup");
const { buildRaceResolutionWorkerV2 } = require("../../src/modules/races/jobs/raceResolutionQueueV2");

let baseUrl;
let observed = null;
prisma.$on("query", event => observed?.push(event.query));
before(async () => { baseUrl = (await getSharedServer()).baseUrl; });
beforeEach(cleanDatabase);

for (const powerupsEnabled of [false, true]) {
  it(`HTTP step sync resolves without loading unused event history (powerups=${powerupsEnabled})`, async () => {
    const account = await createTestUser();
    const now = Date.now();
    const race = await prisma.race.create({ data: {
      creatorId: account.user.id, name: "Unused history", status: "ACTIVE",
      targetSteps: 100000, maxParticipants: 10, powerupsEnabled, timezone: "UTC",
      startedAt: new Date(now - 7200000), endsAt: new Date(now + 86400000),
    } });
    await prisma.raceParticipant.create({ data: {
      raceId: race.id, userId: account.user.id, status: "ACCEPTED",
      joinedAt: new Date(now - 7200000),
    } });
    await prisma.racePowerupEvent.createMany({ data: Array.from({ length: 100 }, () => ({
      raceId: race.id, actorUserId: account.user.id, eventType: "MYSTERY_BOX_OPENED",
      description: "Historical box opening", createdAt: new Date(now - 5400000),
    })) });
    const response = await request(baseUrl, "POST", "/steps/sync-v2", {
      token: account.token, headers: { "Idempotency-Key": randomUUID(), "X-Timezone": "UTC" },
      body: { date: new Date(now).toISOString().slice(0, 10), steps: 50, samples: [{
        periodStart: new Date(now - 3600000).toISOString(),
        periodEnd: new Date(now - 1800000).toISOString(), steps: 50,
      }] },
    });
    assert.equal(response.status, 202);
    const queries = [];
    observed = queries;
    try {
      assert.equal(await buildRaceResolutionWorkerV2({ bootAt: 0 }).tick(), 1);
    } finally { observed = null; }
    const participant = await prisma.raceParticipant.findFirst({ where: { raceId: race.id } });
    assert.equal(participant.totalSteps, 50);
    const job = await prisma.raceResolutionJobV2.findUnique({ where: { raceId: race.id } });
    assert.ok(job.lastCompletedAt);
    assert.ok(queries.some(query => /race_participants/i.test(query)), "query capture is active");
    const historyReads = queries.filter(query => /^\s*SELECT\b/i.test(query) &&
      /\bFROM\s+(?:"public"\.)?"?race_powerup_events"?\b/i.test(query));
    assert.equal(historyReads.length, 0, `unused history reads: ${historyReads.join("\n")}`);
    const progressResponse = await request(baseUrl, "GET", `/races/${race.id}/progress`, {
      token: account.token,
    });
    assert.equal(progressResponse.status, 200);
    const body = await progressResponse.json();
    assert.equal(body.progress.participants.find(row => row.userId === account.user.id).totalSteps, 50);
  });
}
