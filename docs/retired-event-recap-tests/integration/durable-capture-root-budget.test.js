const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { before, beforeEach, describe, it } = require("node:test");
const { cleanDatabase, createTestUser, getSharedServer, prisma, request } = require("./setup");
const { buildGlobalEventSummaryTick } = require("../../src/modules/steps/jobs/globalEventSummary");
const { coordinatedOptimizationMetrics: metrics } = require("../../src/shared/observability/coordinatedOptimizationMetrics");

let server;
const headers = () => ({
  "Idempotency-Key": randomUUID(),
  "X-Timezone": "UTC",
  "X-Client-Features": "impact_summaries,impact_summary_expiry_v1",
});

async function fixture() {
  const account = await createTestUser({ displayName: "Durable capture" });
  const now = Date.now();
  const startsAt = new Date(now - 20 * 60_000);
  const endsAt = new Date(now - 10 * 60_000);
  const localDate = startsAt.toISOString().slice(0, 10);
  const race = await prisma.race.create({ data: {
    creatorId: account.user.id,
    name: "Pinned event input",
    status: "ACTIVE",
    targetSteps: 100_000,
    powerupsEnabled: false,
    startedAt: new Date(now - 30 * 60_000),
    endsAt: new Date(now + 60 * 60_000),
    timezone: "UTC",
  } });
  await prisma.raceParticipant.create({ data: {
    raceId: race.id, userId: account.user.id, status: "ACCEPTED",
    joinedAt: race.startedAt,
  } });
  const event = await prisma.globalStepEvent.create({ data: {
    startsAt, endsAt, multiplier: 2, summaryAttributionVersion: 2,
  } });
  await prisma.globalStepEventEntitlement.create({ data: {
    eventId: event.id, userId: account.user.id, timezone: "UTC", localDate,
    startsAt, endsAt, startOutcome: "ACTIVATED_ON_TIME", startProcessedAt: startsAt,
  } });
  const work = await prisma.globalEventSummaryWork.create({ data: {
    eventId: event.id, userId: account.user.id, status: "WAITING_SYNC",
    expiresAt: new Date(now + 60 * 60_000), requiredRaceCount: 1,
  } });
  await prisma.globalEventRaceImpact.create({ data: {
    eventId: event.id, raceId: race.id, userId: account.user.id,
    status: "PENDING", attributionVersion: 2,
  } });
  return { account, race, event, work, startsAt, endsAt, localDate };
}

function sync(f, steps, idempotencyKey = randomUUID()) {
  return request(server.baseUrl, "POST", "/steps/sync-v2", {
    token: f.account.token,
    headers: { ...headers(), "Idempotency-Key": idempotencyKey },
    body: {
      date: f.localDate, steps,
      samples: [{
        periodStart: f.startsAt.toISOString(), periodEnd: f.endsAt.toISOString(),
        steps, recordingMethod: "automatic",
      }],
    },
  });
}

async function finishCapture(workId) {
  for (let tick = 0; tick < 600; tick++) {
    await buildGlobalEventSummaryTick({ prisma, now: () => new Date() })();
    const artifact = await prisma.globalEventCaptureArtifact.findFirst({ where: { workId } });
    if (artifact) return artifact;
  }
  assert.fail("40-day cold fixture did not finish within 600 bounded worker claims");
}

async function repeatEventWork(f) {
  const event = await prisma.globalStepEvent.create({ data: {
    startsAt: f.startsAt, endsAt: f.endsAt, multiplier: 2, summaryAttributionVersion: 2,
  } });
  await prisma.globalStepEventEntitlement.create({ data: {
    eventId: event.id, userId: f.account.user.id, timezone: "UTC", localDate: f.localDate,
    startsAt: f.startsAt, endsAt: f.endsAt, startOutcome: "ACTIVATED_ON_TIME", startProcessedAt: f.startsAt,
  } });
  const work = await prisma.globalEventSummaryWork.create({ data: {
    eventId: event.id, userId: f.account.user.id, status: "WAITING_SYNC",
    expiresAt: new Date(Date.now() + 3600_000), requiredRaceCount: 1,
  } });
  await prisma.globalEventRaceImpact.create({ data: {
    eventId: event.id, raceId: f.race.id, userId: f.account.user.id,
    status: "PENDING", attributionVersion: 2,
  } });
  return work;
}


describe("durable cached-root aggregation budget", () => {
  before(async () => { server = await getSharedServer(); });
  beforeEach(async () => { await cleanDatabase(); metrics.reset(); });

  it("yields and resumes long warm root vectors without replaying their completed prefix", async () => {
    const f = await fixture();
    const longStart = new Date(f.race.startedAt.getTime() - 40 * 86400000);
    await prisma.race.update({ where: { id: f.race.id }, data: { startedAt: longStart } });
    await prisma.raceParticipant.updateMany({ where: { raceId: f.race.id }, data: { joinedAt: longStart } });
    assert.equal((await sync(f, 200)).status, 202);
    const first = await finishCapture(f.work.id);
    assert.equal(first.payload.attributionDeltaSteps, 200);
    assert.equal((await request(server.baseUrl, "POST", "/steps/sync-v2", {
      token: f.account.token, headers: headers(), body: { date: f.localDate, steps: 200,
        samples: [{ periodStart: new Date(f.endsAt.getTime() + 1000).toISOString(),
          periodEnd: new Date(f.endsAt.getTime() + 61000).toISOString(), steps: 300,
          recordingMethod: "automatic" }],
      },
    })).status, 202);
    const next = await repeatEventWork(f);
    assert.equal((await sync(f, 200)).status, 202);
    const [baseline] = await prisma.$queryRawUnsafe(`SELECT COALESCE(sum((state->>'rootIndex')::integer),0)::int AS advances
      FROM durable_capture_method_progress WHERE state->>'mode'='ROOT_AGGREGATE'`);
    metrics.reset();
    let artifact, previousOperations = 0, claims = 0;
    for (; claims < 600; claims++) {
      await buildGlobalEventSummaryTick({ prisma, now: () => new Date() })();
      const counter = metrics.snapshot().counters.global_summary_capture_projection_root_operations;
      assert.notEqual(counter, undefined, "cached and cold root operations must both be measured");
      assert.ok(counter - previousOperations <= 32,
        "one worker claim must not walk an unbounded warm vector under one nominal scoring operation");
      previousOperations = counter;
      artifact = await prisma.globalEventCaptureArtifact.findFirst({ where: { workId: next.id } });
      if (artifact) break;
    }
    assert.ok(artifact, "bounded root aggregation must eventually complete");
    assert.ok(claims > 0, "the long warm vector must yield between bounded claims");
    assert.equal(artifact.payload.attributionDeltaSteps, 200);
    const [completed] = await prisma.$queryRawUnsafe(`SELECT COALESCE(sum((state->>'rootIndex')::integer),0)::int AS advances
      FROM durable_capture_method_progress WHERE state->>'mode'='ROOT_AGGREGATE'`);
    assert.equal(previousOperations, completed.advances - baseline.advances,
      "warm cached roots execute once each; a yielded prefix must not be queried again");
    assert.equal(metrics.snapshot().histograms.global_summary_capture_durable_fact_bytes?.sum || 0, 0);
  });

  it("keeps exact-date daily input work linear across a race older than thirty days", async (t) => {
    const f = await fixture();
    const historyDays = 40;
    const longStart = new Date(f.race.startedAt.getTime() - historyDays * 86400000);
    await prisma.race.update({ where: { id: f.race.id }, data: { startedAt: longStart } });
    await prisma.raceParticipant.updateMany({ where: { raceId: f.race.id }, data: { joinedAt: longStart } });
    const outsideDay = new Date(longStart.getTime() - 3 * 86400000).toISOString().slice(0, 10);
    await prisma.step.create({ data: { userId: f.account.user.id,
      date: new Date(outsideDay + "T00:00:00.000Z"), steps: 100000,
    } });
    assert.equal((await sync(f, 200)).status, 202);
    const artifact = await finishCapture(f.work.id);
    assert.equal(artifact.payload.attributionDeltaSteps, 200,
      "missing historical daily rows and the outside-range row must not invent event credit");
    const dailyOperations = metrics.snapshot().counters.global_summary_capture_daily_projection_root_operations;
    assert.notEqual(dailyOperations, undefined, "daily root operations must be measured separately");
    t.diagnostic(`${historyDays}-day capture used ${dailyOperations} daily root operations`);
    assert.ok(dailyOperations <= 3 * (historyDays + 3),
      "each requested date must visit only its own pinned day, not all D roots for every one of D dates");
    const [missing] = await prisma.$queryRawUnsafe(`SELECT count(*)::int AS answers
      FROM durable_capture_method_progress WHERE state->>'mode'='ROOT_AGGREGATE'
        AND state->'total'->'answer'='null'::jsonb`);
    assert.ok(missing.answers >= historyDays - 1,
      "requested historical days without a daily row must retain their exact null fallback answer");
    const [owner] = await prisma.$queryRawUnsafe(
      "SELECT context FROM durable_global_event_capture_requests WHERE work_id=$1", f.work.id);
    assert.ok(owner.context.roots.every((root) => root.day !== outsideDay));
  });
});
