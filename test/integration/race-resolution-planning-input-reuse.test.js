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

for (const scenario of [
  { name: "no event", eventMode: null, expected: 50 },
  { name: "legacy global", eventMode: "LEGACY_GLOBAL", expected: 100 },
  { name: "local entitlement", eventMode: "LOCAL_ENTITLEMENTS", expected: 100 },
  { name: "late membership", eventMode: "LOCAL_ENTITLEMENTS", joinedOffset: -2700000, expected: 50 },
  { name: "future local boundary", eventMode: "LOCAL_ENTITLEMENTS", startOffset: 60000, expected: 50 },
  { name: "future legacy boundary", eventMode: "LEGACY_GLOBAL", startOffset: 60000, expected: 50 },
  { name: "ended local interval", eventMode: "LOCAL_ENTITLEMENTS", endOffset: -2700000, expected: 75 },
  { name: "pending local activation", eventMode: "LOCAL_ENTITLEMENTS", startOutcome: "PENDING", expected: 50 },
  { name: "missing local impact", eventMode: "LOCAL_ENTITLEMENTS", missingImpact: true, expected: 50 },
  { name: "event mutation during compute", eventMode: "LOCAL_ENTITLEMENTS", mutateBeforeFence: true, expected: 150 },
  { name: "new HTTP sync during compute", eventMode: "LOCAL_ENTITLEMENTS", syncBeforeFence: true, expected: 120 },
]) {
  const { eventMode } = scenario;
  it(`HTTP sync reuses planned event eligibility but retains a fresh fence (${scenario.name})`, async () => {
    const account = await createTestUser();
    const now = Date.now();
    const race = await prisma.race.create({ data: {
      creatorId: account.user.id, name: "Planning reuse", status: "ACTIVE", targetSteps: 100000,
      maxParticipants: 10, powerupsEnabled: true, timezone: "UTC",
      startedAt: new Date(now - 7200000), endsAt: new Date(now + 86400000),
    } });
    await prisma.raceParticipant.create({ data: {
      raceId: race.id, userId: account.user.id, status: "ACCEPTED",
      joinedAt: scenario.joinedOffset ? new Date(now + scenario.joinedOffset) : race.startedAt,
    } });
    let event;
    if (eventMode) {
      event = await prisma.globalStepEvent.create({ data: {
        startsAt: new Date(now + (scenario.startOffset ?? -5400000)), endsAt: new Date(now + (scenario.endOffset ?? 3600000)),
        scheduleMode: eventMode, multiplier: 2, summaryAttributionVersion: 2,
      } });
      if (eventMode === "LOCAL_ENTITLEMENTS") {
        await prisma.globalStepEventEntitlement.create({ data: {
          eventId: event.id, userId: account.user.id, timezone: "UTC",
          localDate: event.startsAt.toISOString().slice(0, 10), startsAt: event.startsAt, endsAt: event.endsAt,
          startOutcome: scenario.startOutcome || "ACTIVATED_ON_TIME", startProcessedAt: event.startsAt,
        } });
        if (!scenario.missingImpact) await prisma.globalEventRaceImpact.create({ data: {
          eventId: event.id, raceId: race.id, userId: account.user.id, attributionVersion: 2,
        } });
      }
    }
    const response = await request(baseUrl, "POST", "/steps/sync-v2", {
      token: account.token, headers: { "Idempotency-Key": randomUUID(), "X-Timezone": "UTC" },
      body: { date: new Date(now).toISOString().slice(0, 10), steps: 50, samples: [{
        periodStart: new Date(now - 3600000).toISOString(), periodEnd: new Date(now - 1800000).toISOString(), steps: 50,
      }] },
    });
    assert.equal(response.status, 202);
    const queries = [];
    const logs = [];
    const logger = { log: value => { try { logs.push(JSON.parse(value)); } catch {} }, error: console.error, warn: console.warn };
    observed = queries;
    let mutated = false;
    try { assert.equal(await buildRaceResolutionWorkerV2({ bootAt: 0, logger,
      beforeWriteTransaction: scenario.mutateBeforeFence || scenario.syncBeforeFence ? async () => {
        if (mutated) return;
        mutated = true;
        if (scenario.syncBeforeFence) {
          const newer = await request(baseUrl, "POST", "/steps/sync-v2", {
            token: account.token, headers: { "Idempotency-Key": randomUUID(), "X-Timezone": "UTC" },
            body: { date: new Date(now).toISOString().slice(0, 10), steps: 60, samples: [{
              periodStart: new Date(now - 3600000).toISOString(), periodEnd: new Date(now - 1800000).toISOString(), steps: 60,
            }] },
          });
          assert.equal(newer.status, 202);
        } else await prisma.globalStepEvent.update({ where: { id: event.id }, data: { multiplier: 3 } });
      } : undefined,
    }).tick(), 1); }
    finally { observed = null; }
    const progress = await request(baseUrl, "GET", `/races/${race.id}/progress`, { token: account.token });
    assert.equal(progress.status, 200);
    const body = await progress.json();
    assert.equal(body.progress.participants.find(row => row.userId === account.user.id).totalSteps, scenario.expected);
    const completed = logs.find(row => row.event === "race_resolution_v2" && row.computePhaseQueryCount);
    assert.ok(completed, "worker must emit real phase query telemetry");
    assert.ok(queries.filter(q => q.includes("WITH race_window AS")).length >= 2,
      "planning reuse must not eliminate the fresh transaction fingerprint");
    assert.equal(completed.computePhaseQueryCount.globalEvents, 0,
      "computation must use protected planning eligibility instead of reloading the same events and impacts");
    if (scenario.mutateBeforeFence || scenario.syncBeforeFence) {
      assert.equal(mutated, true);
      assert.ok(completed.closureFenceRejections + completed.sourceInputFenceRejections >= 1,
        "an event changed after planning must reject the stale compute before a fresh attempt commits");
    }
  });
}
