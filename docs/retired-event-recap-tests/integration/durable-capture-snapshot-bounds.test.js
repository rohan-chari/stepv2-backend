const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { before, beforeEach, describe, it } = require("node:test");
const { cleanDatabase, createTestUser, getSharedServer, prisma, request } = require("./setup");
const { buildGlobalEventSummaryTick } = require("../../src/modules/steps/jobs/globalEventSummary");
const { coordinatedOptimizationMetrics: metrics } = require("../../src/shared/observability/coordinatedOptimizationMetrics");
let server;

describe("durable capture snapshot bounds", () => {
  before(async () => { server = await getSharedServer(); });
  beforeEach(async () => { await cleanDatabase(); metrics.reset(); });

  it("loads revision heads only inside each race population's own capture window", async () => {
    const accounts = await Promise.all([0, 1, 2].map((index) => createTestUser({ displayName: "Snapshot bounds " + index })));
    const anchor = Math.floor(Date.now() / (3 * 3600000)) * 3 * 3600000;
    const starts = new Date(anchor - 1200000), ends = new Date(anchor - 600000);
    const today = new Date(starts.toISOString().slice(0, 10) + "T00:00:00.000Z");
    await prisma.step.createMany({ data: accounts.flatMap((account) => Array.from({ length: 15 }, (_, day) => ({
      userId: account.user.id, date: new Date(today.getTime() - day * 86400000), steps: 100,
    }))) });
    const windows = [];
    for (const [dependencyIndex, age] of [[1, 14], [2, 0]]) {
      const start = new Date(starts.getTime() - age * 86400000), end = new Date(ends.getTime() - age * 86400000);
      const race = await prisma.race.create({ data: { creatorId: accounts[0].user.id,
        name: "Disjoint population " + dependencyIndex, status: "ACTIVE", targetSteps: 100000,
        powerupsEnabled: true, timezone: "UTC", startedAt: new Date(start.getTime() - 600000),
        endsAt: new Date(end.getTime() + 3600000),
      } });
      const participants = [];
      for (const index of [0, dependencyIndex]) participants.push(await prisma.raceParticipant.create({ data: {
        raceId: race.id, userId: accounts[index].user.id, status: "ACCEPTED", joinedAt: race.startedAt,
      } }));
      const powerup = await prisma.racePowerup.create({ data: { raceId: race.id,
        participantId: participants[1].id, userId: accounts[dependencyIndex].user.id,
        targetUserId: accounts[0].user.id, type: "LEECH", status: "USED",
      } });
      await prisma.raceActiveEffect.create({ data: { raceId: race.id,
        targetParticipantId: participants[0].id, targetUserId: accounts[0].user.id,
        sourceUserId: accounts[dependencyIndex].user.id, powerupId: powerup.id,
        type: "LEECH", status: "ACTIVE", startsAt: start, expiresAt: end, metadata: { ratio: 2 },
      } });
      const event = await prisma.globalStepEvent.create({ data: { startsAt: start, endsAt: end,
        multiplier: 2, summaryAttributionVersion: 2,
      } });
      await prisma.globalStepEventEntitlement.create({ data: { eventId: event.id, userId: accounts[0].user.id,
        timezone: "UTC", localDate: start.toISOString().slice(0, 10), startsAt: start, endsAt: end,
        startOutcome: "ACTIVATED_ON_TIME", startProcessedAt: start,
      } });
      const work = await prisma.globalEventSummaryWork.create({ data: { eventId: event.id,
        userId: accounts[0].user.id, status: "WAITING_SYNC", expiresAt: new Date(Date.now() + 3600000),
        requiredRaceCount: 1,
      } });
      await prisma.globalEventRaceImpact.create({ data: { eventId: event.id, raceId: race.id,
        userId: accounts[0].user.id, status: "PENDING", attributionVersion: 2,
      } });
      await prisma.stepSample.create({ data: { userId: accounts[0].user.id,
        periodStart: start, periodEnd: end, steps: 200,
      } });
      windows.push({ work, race, start, end, dependencyIndex });
    }
    // This one legacy source row creates a sentinel revision, not 40 day heads.
    await prisma.stepSample.create({ data: { userId: accounts[1].user.id,
      periodStart: new Date(starts.getTime() - 40 * 86400000), periodEnd: ends, steps: 0,
    } });
    const response = await request(server.baseUrl, "POST", "/steps/sync-v2", {
      token: accounts[0].token,
      headers: { "Idempotency-Key": randomUUID(), "X-Timezone": "UTC",
        "X-Client-Features": "impact_summaries,impact_summary_expiry_v1" },
      body: { date: starts.toISOString().slice(0, 10), steps: 200,
        samples: [{ periodStart: starts.toISOString(), periodEnd: ends.toISOString(), steps: 200,
          recordingMethod: "automatic" }] },
    });
    assert.equal(response.status, 202);
    const observed = metrics.snapshot().histograms;
    assert.ok(observed.global_summary_capture_snapshot_head_rows, "actual snapshot head rows must be measured");
    assert.ok(observed.global_summary_capture_snapshot_head_bytes, "actual snapshot head bytes must be measured");
    assert.equal(observed.global_summary_capture_snapshot_head_rows.sum, 9,
      "uploader4 + old dependency2ordinary/1sentinel + current dependency2; not all46 heads across the global range");
    assert.ok(observed.global_summary_capture_snapshot_head_bytes.sum < 2000);
    const requests = await prisma.$queryRawUnsafe(
      "SELECT work_id,context FROM durable_global_event_capture_requests WHERE user_id=$1", accounts[0].user.id);
    assert.equal(requests.length, 2);
    for (const row of requests) {
      const window = windows.find((value) => value.work.id === row.work_id);
      const dependencyRoots = row.context.roots.filter((root) => root.userId === accounts[window.dependencyIndex].user.id);
      assert.ok(dependencyRoots.some((root) => root.day === "0001-01-01"));
      assert.ok(dependencyRoots.some((root) => root.revision === "0"), "missing heads pin explicit revision-zero roots");
      assert.equal(dependencyRoots.length, 4);
    }
    for (let claim = 0; claim < 80 && await prisma.globalEventCaptureArtifact.count() < 2; claim++) {
      await buildGlobalEventSummaryTick({ prisma, now: () => new Date() })();
    }
    const artifacts = await prisma.globalEventCaptureArtifact.findMany();
    assert.equal(artifacts.length, 2);
    assert.ok(artifacts.every((artifact) => artifact.payload.attributionDeltaSteps === 200));
  });
});
