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
  for (let tick = 0; tick < 80; tick++) {
    await buildGlobalEventSummaryTick({ prisma, now: () => new Date() })();
    const artifact = await prisma.globalEventCaptureArtifact.findFirst({ where: { workId } });
    if (artifact) return artifact;
  }
  assert.fail("durable capture did not finish within 80 bounded worker claims");
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


describe("durable interval projection reuse", () => {
  before(async () => { server = await getSharedServer(); });
  beforeEach(async () => { await cleanDatabase(); });

  async function changeOutside(f) {
    const start = new Date(f.endsAt.getTime() + 1000);
    const end = new Date(f.endsAt.getTime() + 61000);
    assert.equal((await request(server.baseUrl, "POST", "/steps/sync-v2", {
      token: f.account.token, headers: headers(), body: { date: f.localDate, steps: 500,
        samples: [{ periodStart: start.toISOString(), periodEnd: end.toISOString(),
          steps: 300, recordingMethod: "automatic" }],
      },
    })).status, 202);
  }

  it("reuses exact sample answers after same-day mutations without reading immutable payloads", async () => {
    const f = await fixture();
    assert.equal((await sync(f, 200)).status, 202);
    assert.equal((await finishCapture(f.work.id)).payload.attributionDeltaSteps, 200);
    await changeOutside(f);
    const next = await repeatEventWork(f);
    assert.equal((await sync(f, 200)).status, 202);
    metrics.reset();
    const result = await finishCapture(next.id);
    assert.equal(result.payload.attributionDeltaSteps, 200);
    assert.equal(metrics.snapshot().histograms.global_summary_capture_durable_fact_bytes?.sum || 0, 0);
  });

  it("revalidates changed roots when journal proof has been compacted, never assumes missing rows mean zero", async () => {
    const f = await fixture();
    assert.equal((await sync(f, 200)).status, 202);
    assert.equal((await finishCapture(f.work.id)).payload.attributionDeltaSteps, 200);
    await changeOutside(f);
    // Fault-inject the allowed retention boundary after no unfinished old root remains.
    await prisma.$executeRawUnsafe("DELETE FROM durable_capture_fact_journal WHERE user_id=$1", f.account.user.id);
    await prisma.$executeRawUnsafe("UPDATE durable_capture_fact_heads SET compacted_revision=revision WHERE user_id=$1",
      f.account.user.id);
    const next = await repeatEventWork(f);
    assert.equal((await sync(f, 200)).status, 202);
    metrics.reset();
    const result = await finishCapture(next.id);
    assert.equal(result.payload.attributionDeltaSteps, 200);
    const [projected] = await prisma.$queryRawUnsafe(
      "SELECT count(*)::int AS count FROM durable_capture_interval_projections WHERE user_id=$1", f.account.user.id);
    assert.ok(projected.count > 0, "worker must retain reusable bounded root projections");
    assert.ok((metrics.snapshot().histograms.global_summary_capture_durable_fact_bytes?.sum || 0) > 0,
      "compacted proof requires a real immutable changed-root read");
  });

  it("applies in-window journal corrections while accepted captures retain their original result", async () => {
    const f = await fixture();
    assert.equal((await sync(f, 200)).status, 202);
    const original = await finishCapture(f.work.id);
    const next = await repeatEventWork(f);
    assert.equal((await sync(f, 900)).status, 202);
    const result = await finishCapture(next.id);
    assert.equal(result.payload.attributionDeltaSteps, 900);
    assert.equal((await prisma.globalEventCaptureArtifact.findUniqueOrThrow({ where: { id: original.id } }))
      .payload.attributionDeltaSteps, 200);
  });

  it("falls back to immutable facts when a retained journal has a gap", async () => {
    const f = await fixture();
    assert.equal((await sync(f, 200)).status, 202);
    await finishCapture(f.work.id);
    const next = await repeatEventWork(f);
    assert.equal((await sync(f, 900)).status, 202);
    // Missing journal without a matching compaction watermark is corruption,
    // not evidence of unchanged input. Current pinned Q is still reconstructible.
    await prisma.$executeRawUnsafe(`DELETE FROM durable_capture_fact_journal
      WHERE user_id=$1 AND revision=(SELECT max(revision) FROM durable_capture_fact_journal WHERE user_id=$1)`,
    f.account.user.id);
    metrics.reset();
    assert.equal((await finishCapture(next.id)).payload.attributionDeltaSteps, 900);
    assert.ok((metrics.snapshot().histograms.global_summary_capture_durable_fact_bytes?.sum || 0) > 0);
  });

  it("does not invalidate sample-window answers when only the daily counter changes", async () => {
    const f = await fixture();
    assert.equal((await sync(f, 200)).status, 202);
    await finishCapture(f.work.id);
    const next = await repeatEventWork(f);
    assert.equal((await request(server.baseUrl, "POST", "/steps/sync-v2", {
      token: f.account.token, headers: headers(), body: { date: f.localDate, steps: 900,
        samples: [{ periodStart: f.startsAt.toISOString(), periodEnd: f.endsAt.toISOString(),
          steps: 200, recordingMethod: "automatic" }],
      },
    })).status, 202);
    metrics.reset();
    assert.equal((await finishCapture(next.id)).payload.attributionDeltaSteps, 200);
    assert.equal(metrics.snapshot().histograms.global_summary_capture_durable_fact_bytes?.sum || 0, 0);
  });

  it("does not reuse a retired head's answer when a new root repeats its numeric revision", async () => {
    const f = await fixture();
    assert.equal((await sync(f, 200)).status, 202);
    await finishCapture(f.work.id);
    const [pending] = await prisma.$queryRawUnsafe(`SELECT count(*)::int AS count
      FROM durable_global_event_capture_requests WHERE user_id=$1 AND status IN ('PENDING','PROCESSING')`,
    f.account.user.id);
    assert.equal(pending.count, 0);
    // Fault-inject completed-input retirement, retaining only derived answers
    // that may legitimately outlive the old root/head epoch.
    await prisma.$executeRawUnsafe("DELETE FROM durable_capture_fact_roots WHERE user_id=$1", f.account.user.id);
    await prisma.$executeRawUnsafe("DELETE FROM durable_capture_fact_journal WHERE user_id=$1", f.account.user.id);
    await prisma.$executeRawUnsafe("DELETE FROM durable_capture_fact_heads WHERE user_id=$1", f.account.user.id);
    const next = await repeatEventWork(f);
    assert.equal((await sync(f, 900)).status, 202);
    assert.equal((await finishCapture(next.id)).payload.attributionDeltaSteps, 900);
    const again = await repeatEventWork(f);
    assert.equal((await sync(f, 900)).status, 202);
    metrics.reset();
    assert.equal((await finishCapture(again.id)).payload.attributionDeltaSteps, 900);
    assert.equal(metrics.snapshot().histograms.global_summary_capture_durable_fact_bytes?.sum || 0, 0,
      "exact new root identity must win over a retired epoch's equal numeric revision");
  });

  it("advances moved cross-midnight samples without duplicating their day-chunk contributions", async () => {
    const f = await fixture();
    f.startsAt = new Date(Math.floor(Date.now() / 86400000) * 86400000 - 86400000);
    f.endsAt = new Date(f.startsAt.getTime() + 600000);
    f.localDate = f.startsAt.toISOString().slice(0, 10);
    await prisma.race.update({ where: { id: f.race.id }, data: {
      startedAt: new Date(f.startsAt.getTime() - 1800000),
    } });
    await prisma.globalStepEvent.update({ where: { id: f.event.id }, data: {
      startsAt: f.startsAt, endsAt: f.endsAt,
    } });
    await prisma.globalStepEventEntitlement.updateMany({ where: { eventId: f.event.id }, data: {
      startsAt: f.startsAt, endsAt: f.endsAt, localDate: f.localDate,
    } });
    const middle = new Date(f.startsAt.getTime() + 300000);
    assert.equal((await request(server.baseUrl, "POST", "/steps/sync-v2", {
      token: f.account.token, headers: headers(), body: { date: f.localDate, steps: 200,
        samples: [{ periodStart: new Date(f.startsAt.getTime() - 300000).toISOString(),
          periodEnd: middle.toISOString(), steps: 200, recordingMethod: "automatic" },
        { periodStart: middle.toISOString(), periodEnd: f.endsAt.toISOString(), steps: 0, recordingMethod: "automatic" }],
      },
    })).status, 202);
    assert.equal((await finishCapture(f.work.id)).payload.attributionDeltaSteps, 100);
    const next = await repeatEventWork(f);
    // Supply a finer replacement, which the real source reconciliation accepts;
    // a single coarser sample would intentionally preserve the previous facts.
    assert.equal((await request(server.baseUrl, "POST", "/steps/sync-v2", {
      token: f.account.token, headers: headers(), body: { date: f.localDate, steps: 200,
        samples: [{ periodStart: new Date(f.startsAt.getTime() - 300000).toISOString(),
          periodEnd: f.startsAt.toISOString(), steps: 100, recordingMethod: "automatic" },
        { periodStart: f.startsAt.toISOString(), periodEnd: middle.toISOString(),
          steps: 200, recordingMethod: "automatic" },
        { periodStart: middle.toISOString(), periodEnd: f.endsAt.toISOString(), steps: 0, recordingMethod: "automatic" }],
      },
    })).status, 202);
    metrics.reset();
    assert.equal((await finishCapture(next.id)).payload.attributionDeltaSteps, 200);
    assert.equal(metrics.snapshot().histograms.global_summary_capture_durable_fact_bytes?.sum || 0, 0);
  });

  it("bounds the recent proof tail and collects it after its quiet interval", async () => {
    const f = await fixture();
    assert.equal((await sync(f, 200)).status, 202);
    await finishCapture(f.work.id);
    // Exercise source-table writer coverage without manufacturing journal rows.
    for (let mutation = 0; mutation < 300; mutation++) {
      await prisma.$executeRawUnsafe("UPDATE step_samples SET steps=steps+1 WHERE user_id=$1", f.account.user.id);
    }
    await prisma.$executeRawUnsafe("UPDATE durable_capture_fact_heads SET next_compaction_at=now() WHERE user_id=$1",
      f.account.user.id);
    // Simulated maintenance time must advance the new durable runner clock as
    // well as the existing per-head clock. Retention assertions stay unchanged.
    await prisma.$executeRawUnsafe("UPDATE durable_capture_compaction_schedule SET next_due_at=now()");
    await buildGlobalEventSummaryTick({ prisma, now: () => new Date() })();
    const [recent] = await prisma.$queryRawUnsafe(
      "SELECT count(*)::int AS count FROM durable_capture_fact_journal WHERE user_id=$1", f.account.user.id);
    assert.equal(recent.count, 256, "hot history retains a fixed maximum proof tail");
    for (let pass = 0; pass < 3; pass++) {
      await prisma.$executeRawUnsafe(`UPDATE durable_capture_fact_heads
        SET next_compaction_at=now(),updated_at=now()-INTERVAL '11 minutes' WHERE user_id=$1`, f.account.user.id);
      await prisma.$executeRawUnsafe("UPDATE durable_capture_compaction_schedule SET next_due_at=now()");
      await buildGlobalEventSummaryTick({ prisma, now: () => new Date() })();
    }
    const [quiet] = await prisma.$queryRawUnsafe(
      "SELECT count(*)::int AS count FROM durable_capture_fact_journal WHERE user_id=$1", f.account.user.id);
    assert.equal(quiet.count, 0, "quiet chunks do not retain an indefinite journal tail");
  });

  it("preserves exact contributions when legacy facts move into and out of the long-span sentinel", async () => {
    const f = await fixture();
    assert.equal((await sync(f, 200)).status, 202);
    await finishCapture(f.work.id);
    // Legacy writers may retain arbitrarily long samples even though today's
    // HTTP validator need not accept that representation. Exercise the source
    // trigger, then accept and calculate every capture through HTTP + worker.
    const longStart = new Date(f.startsAt.getTime() - 33 * 86400000);
    const longSteps = 400 * ((f.endsAt.getTime() - longStart.getTime()) / 600000);
    await prisma.$executeRawUnsafe(`UPDATE step_samples SET period_start=$2::timestamp,steps=$3
      WHERE user_id=$1`, f.account.user.id, longStart, longSteps);
    const next = await repeatEventWork(f);
    assert.equal((await sync(f, 200)).status, 202);
    metrics.reset();
    assert.equal((await finishCapture(next.id)).payload.attributionDeltaSteps, 400);
    assert.equal(metrics.snapshot().histograms.global_summary_capture_durable_fact_bytes?.sum || 0, 0);

    await prisma.$executeRawUnsafe(`UPDATE step_samples SET period_start=$2::timestamp,steps=600
      WHERE user_id=$1`, f.account.user.id, f.startsAt);
    const again = await repeatEventWork(f);
    assert.equal((await sync(f, 600)).status, 202);
    metrics.reset();
    assert.equal((await finishCapture(again.id)).payload.attributionDeltaSteps, 600);
    assert.equal(metrics.snapshot().histograms.global_summary_capture_durable_fact_bytes?.sum || 0, 0);
  });
});
