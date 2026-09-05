const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const path = require("node:path");
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

describe("durable asynchronous global-event capture", () => {
  before(async () => { server = await getSharedServer(); });
  beforeEach(async () => { await cleanDatabase(); });

  it("accepts the sync before calculating or publishing its capture artifact", async () => {
    const f = await fixture();
    const response = await sync(f, 200);
    assert.equal(response.status, 202);
    assert.equal(await prisma.globalEventCaptureArtifact.count({
      where: { workId: f.work.id },
    }), 0, "HTTP intake must leave durable pending capture work for the worker");
    const work = await prisma.globalEventSummaryWork.findUniqueOrThrow({ where: { id: f.work.id } });
    assert.equal(work.captureCoverageThrough.toISOString(), f.endsAt.toISOString());
    assert.ok(work.captureSyncRequestId);
    assert.equal(work.status, "QUEUED", "older clients must receive an existing public work state");
    assert.match(work.leaseToken, /^capture:/);
    assert.equal(work.leaseUntil.toISOString(), work.expiresAt.toISOString(),
      "rolling older workers must not reclaim a parked capture before its deadline");
    const [legacyClaimable] = await prisma.$queryRawUnsafe(`SELECT count(*)::int AS count
      FROM global_event_summary_work WHERE id=$1 AND status='QUEUED' AND lease_until IS NULL`, work.id);
    assert.equal(legacyClaimable.count, 0, "the legacy queued-work claim predicate must exclude unfinished captures");

    const artifact = await finishCapture(f.work.id);
    assert.equal(artifact.payload.attributionDeltaSteps, 200);
  });

  it("scores the accepted input version even when a later sync replaces its samples", async () => {
    const f = await fixture();
    assert.equal((await sync(f, 200)).status, 202);
    const pinned = await prisma.globalEventSummaryWork.findUniqueOrThrow({ where: { id: f.work.id } });
    assert.equal((await sync(f, 900)).status, 202);
    const artifact = await finishCapture(f.work.id);
    assert.equal(artifact.captureSyncRequestId, pinned.captureSyncRequestId);
    assert.equal(artifact.payload.attributionDeltaSteps, 200,
      "asynchronous reconstruction must retain the accepted 200-step preimage");
    assert.equal(Object.hasOwn(artifact.payload, "samples"), false,
      "final outcomes must reference immutable facts instead of duplicating raw histories");
    assert.equal(Object.hasOwn(artifact.payload, "dailySteps"), false);
  });

  it("reuses prepared history in a genuinely fresh worker process", async () => {
    const f = await fixture();
    async function freshWorker(workId) {
      const { stdout } = await promisify(execFile)(process.execPath,
        [path.join(__dirname, "helpers/runDurableCaptureWorker.js"), workId],
        { env: { ...process.env, NODE_ENV: "test", REDIS_URL: "" }, timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
      const result = stdout.split("\n").find((line) => line.startsWith("DURABLE_WORKER_RESULT="));
      assert.ok(result, "fresh process must report its real worker result");
      return JSON.parse(result.slice("DURABLE_WORKER_RESULT=".length));
    }
    assert.equal((await sync(f, 200)).status, 202);
    const cold = await freshWorker(f.work.id);
    assert.equal(cold.delta, 200);
    assert.ok(cold.metrics.histograms.global_summary_capture_durable_fact_bytes.sum > 0);
    const next = await repeatEventWork(f);
    assert.equal((await sync(f, 200)).status, 202);
    const warm = await freshWorker(next.id);
    assert.notEqual(warm.pid, cold.pid);
    assert.notEqual(warm.pid, process.pid);
    assert.notEqual(warm.artifactId, cold.artifactId);
    assert.equal(warm.delta, 200);
    assert.equal(warm.metrics.histograms.global_summary_capture_durable_fact_bytes, undefined,
      "a new process must reuse durable scalar inputs without rereading immutable history");
    assert.equal(warm.metrics.histograms.global_summary_capture_sample_db_rows, undefined,
      "process lifetime must not turn unchanged historical roots into source misses");
  });

  it("reports physical source preparation separately from immutable page reads", async () => {
    const f = await fixture();
    const idempotencyKey = randomUUID();
    metrics.reset();
    assert.equal((await sync(f, 200, idempotencyKey)).status, 202);
    assert.equal(metrics.snapshot().histograms.global_summary_capture_sample_db_rows, undefined,
      "intake must not hydrate capture source facts");
    const artifact = await finishCapture(f.work.id);
    assert.equal(artifact.payload.attributionDeltaSteps, 200);
    const [prepared] = await prisma.$queryRawUnsafe(`SELECT
      coalesce(sum(source_sample_rows),0)::int AS samples,
      coalesce(sum(source_daily_rows),0)::int AS daily,
      coalesce(sum(journal_rows),0)::int AS journal
      FROM durable_capture_fact_roots`);
    assert.ok(prepared.samples > 0, "this cold HTTP fixture must actually read source samples");
    const observed = metrics.snapshot().histograms;
    for (const [name, expected] of [
      ["global_summary_capture_sample_db_rows", prepared.samples],
      ["global_summary_capture_daily_db_rows", prepared.daily],
      ["global_summary_capture_journal_db_rows", prepared.journal],
    ]) {
      assert.ok(observed[name], `${name} must be emitted at the physical materialization boundary`);
      assert.equal(observed[name].sum, expected);
    }
    assert.ok(observed.global_summary_capture_durable_fact_bytes.sum > 0,
      "immutable bytes consumed are distinct from mutable source rows prepared");

    metrics.reset();
    assert.equal((await sync(f, 200, idempotencyKey)).status, 202);
    for (let attempt = 0; attempt < 3; attempt++) {
      await buildGlobalEventSummaryTick({ prisma, now: () => new Date() })();
    }
    const retried = await prisma.globalEventCaptureArtifact.findMany({ where: { workId: f.work.id } });
    assert.deepEqual(retried.map((row) => row.id), [artifact.id]);
    for (const name of ["global_summary_capture_sample_db_rows", "global_summary_capture_daily_db_rows",
      "global_summary_capture_journal_db_rows", "global_summary_capture_durable_fact_bytes"]) {
      assert.equal(metrics.snapshot().histograms[name], undefined,
        "an already published upload retry must not reread inputs or recount lifetime root work");
    }
  });

  it("retains accepted facts when source retention deletes samples before the worker reads them", async () => {
    const f = await fixture();
    assert.equal((await sync(f, 200)).status, 202);
    assert.equal(await prisma.globalEventCaptureArtifact.count({ where: { workId: f.work.id } }), 0);
    await prisma.$transaction(async (tx) => {
      await tx.stepSample.deleteMany({ where: { userId: f.account.user.id } });
      await tx.step.deleteMany({ where: { userId: f.account.user.id } });
    });
    assert.equal(await prisma.stepSample.count({ where: { userId: f.account.user.id } }), 0);
    assert.equal(await prisma.step.count({ where: { userId: f.account.user.id } }), 0);
    const artifact = await finishCapture(f.work.id);
    assert.equal(artifact.payload.attributionDeltaSteps, 200,
      "source retention must not turn an accepted positive summary into zero steps");
    const [retained] = await prisma.$queryRawUnsafe(`SELECT count(*)::int AS count
      FROM durable_capture_fact_journal WHERE user_id=$1 AND before_fact IS NOT NULL`, f.account.user.id);
    assert.ok(retained.count > 0, "pending immutable reconstruction must retain deleted input preimages");
  });

  it("does not let event retention bypass recent capture provenance and bounded pin cleanup", async () => {
    const f = await fixture();
    assert.equal((await sync(f, 200)).status, 202);
    const artifact = await finishCapture(f.work.id);
    // Establish an old terminal event with a recently completed capture (for
    // example, recovered work). Event age must not replace capture age.
    const oldEnd = new Date(Date.now() - 40 * 86400_000);
    await prisma.globalStepEventEntitlement.updateMany({ where: { eventId: f.event.id },
      data: { startsAt: new Date(oldEnd.getTime() - 600_000), endsAt: oldEnd,
        localDate: oldEnd.toISOString().slice(0, 10), startProcessedAt: oldEnd, endProcessedAt: oldEnd } });
    await prisma.race.update({ where: { id: f.race.id }, data: { status: "COMPLETED" } });
    await prisma.globalEventRaceImpact.updateMany({ where: { eventId: f.event.id }, data: { status: "UNSCORABLE" } });
    await prisma.globalEventSummaryWork.update({ where: { id: f.work.id }, data: { status: "UNSCORABLE" } });
    const [before] = await prisma.$queryRawUnsafe(`SELECT count(*)::int AS count FROM durable_capture_fact_pins
      WHERE owner_id=$1::uuid`, artifact.payload.durableCaptureId);
    assert.ok(before.count > 0);
    const { cleanupExpiredEntitlements } = require("../../src/modules/steps/services/globalStepEventRetention");
    const result = await cleanupExpiredEntitlements({ client: prisma, now: new Date() });
    assert.equal(result.deletedEntitlements, 0,
      "event-age cleanup must defer while capture-age provenance is still retained");
    const [after] = await prisma.$queryRawUnsafe(`SELECT count(*)::int AS count FROM durable_capture_fact_pins
      WHERE owner_id=$1::uuid`, artifact.payload.durableCaptureId);
    assert.equal(after.count, before.count, "routine retention must not cascade all capture pins");
    assert.equal(await prisma.globalEventCaptureArtifact.count({ where: { id: artifact.id } }), 1);

    await prisma.$executeRawUnsafe(`UPDATE durable_global_event_capture_requests
      SET completed_at=clock_timestamp()-interval '31 days' WHERE id=$1::uuid`, artifact.payload.durableCaptureId);
    for (let attempt = 0; attempt < 20; attempt++) {
      await buildGlobalEventSummaryTick({ prisma, now: () => new Date() })();
      const [remaining] = await prisma.$queryRawUnsafe(`SELECT count(*)::int AS count
        FROM durable_global_event_capture_requests WHERE id=$1::uuid`, artifact.payload.durableCaptureId);
      if (!remaining.count) break;
    }
    const collected = await cleanupExpiredEntitlements({ client: prisma, now: new Date() });
    assert.equal(collected.deletedEntitlements, 1,
      "the original retention lifecycle must complete after bounded capture cleanup retires the owner");
  });

  it("pins race metadata and dependency revisions from one committed snapshot", async () => {
    const f = await fixture();
    const dependency = await createTestUser({ displayName: "Concurrent capture dependency" });
    await prisma.race.update({ where: { id: f.race.id }, data: { powerupsEnabled: true } });
    const target = await prisma.raceParticipant.findFirstOrThrow({ where: { raceId: f.race.id, userId: f.account.user.id } });
    const source = await prisma.raceParticipant.create({ data: { raceId: f.race.id, userId: dependency.user.id,
      status: "ACCEPTED", joinedAt: f.race.startedAt } });
    const sample = await prisma.stepSample.create({ data: { userId: dependency.user.id,
      periodStart: f.startsAt, periodEnd: f.endsAt, steps: 100 } });
    const powerup = await prisma.racePowerup.create({ data: { raceId: f.race.id, participantId: source.id,
      userId: dependency.user.id, targetUserId: f.account.user.id, type: "LEECH", status: "USED" } });
    const effect = await prisma.raceActiveEffect.create({ data: { raceId: f.race.id, powerupId: powerup.id,
      targetParticipantId: target.id, targetUserId: f.account.user.id, sourceUserId: dependency.user.id,
      type: "LEECH", status: "EXPIRED", startsAt: f.startsAt, expiresAt: f.endsAt, metadata: { ratio: 2 } } });
    let unlock;
    let acquired;
    const ready = new Promise((resolve) => { acquired = resolve; });
    const release = new Promise((resolve) => { unlock = resolve; });
    const fence = prisma.$transaction(async (tx) => {
      await tx.$queryRawUnsafe("SELECT pg_advisory_xact_lock(904205010001::bigint)::text");
      acquired();
      await release;
    }, { timeout: 15000 });
    await ready;
    const intake = sync(f, 200);
    try {
      let blocked = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const [waiting] = await prisma.$queryRawUnsafe(`SELECT count(*)::int AS count FROM pg_stat_activity
          WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event='advisory'
            AND (query LIKE '%durable_capture_pin_roots%' OR query LIKE '%pg_advisory_xact_lock_shared%')`);
        if (waiting.count) { blocked = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.ok(blocked, "real HTTP capture must reach the held input-retention fence");
      // A non-cooperating metadata writer and source writer commit atomically.
      // Either old pair (ratio2,100) or new pair (ratio1,400) is coherent;
      // the intake blocked before its snapshot must observe the new pair.
      await prisma.$transaction(async (tx) => {
        await tx.raceActiveEffect.update({ where: { id: effect.id }, data: { metadata: { ratio: 1 } } });
        await tx.stepSample.update({ where: { id: sample.id }, data: { steps: 400 } });
      });
    } finally {
      unlock();
      await fence;
    }
    assert.equal((await intake).status, 202);
    const [accepted] = await prisma.$queryRawUnsafe("SELECT context FROM durable_global_event_capture_requests WHERE work_id=$1", f.work.id);
    const pinnedEffect = accepted.context.captures[0].payload.effects.find((row) => row.id === effect.id);
    assert.equal(pinnedEffect.metadata.ratio, 1,
      "metadata read before the retention fence must not be combined with revisions read after it");
    assert.equal((await finishCapture(f.work.id)).payload.attributionDeltaSteps, 0,
      "the coherent new input pair drains both event scenarios to zero");
  });

  it("reclaims an abandoned compute lease and publishes only once across upload retries", async () => {
    const f = await fixture();
    const idempotencyKey = randomUUID();
    const accepted = await sync(f, 200, idempotencyKey);
    assert.equal(accepted.status, 202);
    const abandonedToken = randomUUID();
    await prisma.$executeRawUnsafe(`UPDATE durable_global_event_capture_requests
      SET status='PROCESSING',lease_token=$2::uuid,lease_until=clock_timestamp()-interval '1 second',attempt_count=1
      WHERE work_id=$1`, f.work.id, abandonedToken);
    const artifact = await finishCapture(f.work.id);
    assert.equal(artifact.payload.attributionDeltaSteps, 200);
    const replay = await sync(f, 200, idempotencyKey);
    assert.equal(replay.status, 202);
    for (let tick = 0; tick < 3; tick++) await buildGlobalEventSummaryTick({ prisma, now: () => new Date() })();
    const [capture] = await prisma.$queryRawUnsafe(`SELECT status,attempt_count,lease_token
      FROM durable_global_event_capture_requests WHERE work_id=$1`, f.work.id);
    assert.equal(capture.status, "COMPLETE");
    assert.ok(capture.attempt_count > 1);
    assert.equal(capture.lease_token, null);
    assert.equal(await prisma.globalEventCaptureArtifact.count({ where: { workId: f.work.id } }), 1);
    assert.equal((await prisma.globalEventCaptureArtifact.findFirstOrThrow({ where: { workId: f.work.id } })).id, artifact.id);
  });

  it("expires pending captures without preparing facts and releases their pins", async () => {
    const f = await fixture();
    assert.equal((await sync(f, 200)).status, 202);
    await prisma.$executeRawUnsafe(`UPDATE durable_global_event_capture_requests
      SET expires_at=clock_timestamp()-interval '1 second' WHERE work_id=$1`, f.work.id);
    await prisma.globalEventSummaryWork.update({ where: { id: f.work.id }, data: {
      expiresAt: new Date(Date.now() - 1000),
    } });
    await buildGlobalEventSummaryTick({ prisma, now: () => new Date() })();
    const [capture] = await prisma.$queryRawUnsafe(`SELECT id,status FROM
      durable_global_event_capture_requests WHERE work_id=$1`, f.work.id);
    assert.equal(capture.status, "EXPIRED");
    const [pins] = await prisma.$queryRawUnsafe(`SELECT count(*)::int AS count
      FROM durable_capture_fact_pins WHERE owner_id=$1::uuid`, capture.id);
    assert.equal(pins.count, 0);
    const [prepared] = await prisma.$queryRawUnsafe(`SELECT count(*)::int AS count
      FROM durable_capture_fact_roots WHERE prepared_at IS NOT NULL`);
    assert.equal(prepared.count, 0, "expired work must not hydrate any scoring inputs");
    assert.equal(await prisma.globalEventCaptureArtifact.count({ where: { workId: f.work.id } }), 0);
  });

  it("terminalizes a corrupt capture without publishing or retrying it forever", async () => {
    const f = await fixture();
    assert.equal((await sync(f, 200)).status, 202);
    await prisma.$executeRawUnsafe(`UPDATE durable_global_event_capture_requests
      SET context_digest=repeat('0',64) WHERE work_id=$1`, f.work.id);
    await buildGlobalEventSummaryTick({ prisma, now: () => new Date() })();
    const [capture] = await prisma.$queryRawUnsafe(`SELECT id,status,last_error_code FROM
      durable_global_event_capture_requests WHERE work_id=$1`, f.work.id);
    assert.equal(capture.status, "FAILED");
    assert.equal(capture.last_error_code, "INPUTS_NOT_RETAINED");
    const work = await prisma.globalEventSummaryWork.findUniqueOrThrow({ where: { id: f.work.id } });
    assert.equal(work.status, "UNSCORABLE");
    assert.equal(work.leaseToken, null);
    assert.equal(await prisma.globalEventCaptureArtifact.count({ where: { workId: f.work.id } }), 0);
    const [pins] = await prisma.$queryRawUnsafe(`SELECT count(*)::int AS count
      FROM durable_capture_fact_pins WHERE owner_id=$1::uuid`, capture.id);
    assert.equal(pins.count, 0);
  });

  it("retains the existing scoring-input size bound for durable request metadata", async () => {
    const f = await fixture();
    await prisma.race.update({ where: { id: f.race.id }, data: { powerupsEnabled: true } });
    const participant = await prisma.raceParticipant.findFirstOrThrow({ where: { raceId: f.race.id } });
    const powerup = await prisma.racePowerup.create({ data: {
      raceId: f.race.id, participantId: participant.id, userId: f.account.user.id,
      targetUserId: f.account.user.id, type: "RUNNERS_HIGH", status: "USED",
    } });
    await prisma.raceActiveEffect.create({ data: {
      raceId: f.race.id, targetParticipantId: participant.id, targetUserId: f.account.user.id,
      sourceUserId: f.account.user.id, powerupId: powerup.id, type: "RUNNERS_HIGH", status: "ACTIVE",
      startsAt: f.startsAt, expiresAt: f.endsAt,
      metadata: { multiplier: 2, retainedMetadata: "x".repeat(16 * 1024 * 1024) },
    } });
    assert.equal((await sync(f, 200)).status, 202);
    const work = await prisma.globalEventSummaryWork.findUniqueOrThrow({ where: { id: f.work.id } });
    assert.equal(work.status, "UNSCORABLE");
    assert.equal(work.lastErrorCode, "INPUTS_NOT_RETAINED");
    const [requests] = await prisma.$queryRawUnsafe(`SELECT count(*)::int AS count
      FROM durable_global_event_capture_requests WHERE work_id=$1`, f.work.id);
    assert.equal(requests.count, 0, "oversized context must not enter the scoring queue");
    const [pins] = await prisma.$queryRawUnsafe("SELECT count(*)::int AS count FROM durable_capture_fact_pins");
    assert.equal(pins.count, 0);
  });

  it("yields oversized input preparation and resumes to the exact event result", async () => {
    const f = await fixture();
    await prisma.stepSample.createMany({ data: Array.from({ length: 600 }, (_, index) => ({
      userId: f.account.user.id,
      periodStart: new Date(f.race.startedAt.getTime() + index * 1000),
      periodEnd: new Date(f.race.startedAt.getTime() + (index + 1) * 1000), steps: 1,
    })) });
    assert.equal((await sync(f, 200)).status, 202);
    const { stdout } = await promisify(execFile)(process.execPath,
      [path.join(__dirname, "helpers/runDurableCaptureWorker.js"), f.work.id, "single"],
      { env: { ...process.env, NODE_ENV: "test", REDIS_URL: "" }, timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
    const line = stdout.split("\n").find((value) => value.startsWith("DURABLE_WORKER_RESULT="));
    assert.ok(line);
    const exitedWorker = JSON.parse(line.slice("DURABLE_WORKER_RESULT=".length));
    assert.notEqual(exitedWorker.pid, process.pid);
    assert.equal(exitedWorker.artifactId, null);
    assert.ok(exitedWorker.metrics.histograms.global_summary_capture_sample_db_rows.sum > 0,
      "the exited worker must have made real source-preparation progress");
    assert.equal(await prisma.globalEventCaptureArtifact.count({ where: { workId: f.work.id } }), 0,
      "one claim must not prepare an unbounded source history");
    let artifact;
    for (let tick = 0; tick < 80 && !artifact; tick++) {
      await buildGlobalEventSummaryTick({ prisma, now: () => new Date() })();
      artifact = await prisma.globalEventCaptureArtifact.findFirst({ where: { workId: f.work.id } });
    }
    assert.ok(artifact, "another process must resume durable page cursors after the first worker exits");
    assert.equal(artifact.payload.attributionDeltaSteps, 200);
  });

  it("collects old completed capture inputs without releasing pending capture pins", async () => {
    const f = await fixture();
    assert.equal((await sync(f, 200)).status, 202);
    await finishCapture(f.work.id);
    const pendingWork = await repeatEventWork(f);
    assert.equal((await sync(f, 200)).status, 202);
    await prisma.$executeRawUnsafe(`UPDATE durable_global_event_capture_requests
      SET completed_at=clock_timestamp()-interval '31 days' WHERE work_id=$1`, f.work.id);
    await prisma.$executeRawUnsafe(`UPDATE durable_global_event_capture_requests
      SET available_at=clock_timestamp()+interval '10 minutes' WHERE work_id=$1`, pendingWork.id);
    for (const table of ["durable_capture_prepared_inputs", "durable_capture_method_progress"]) {
      await prisma.$executeRawUnsafe(`UPDATE ${table} SET updated_at=clock_timestamp()-interval '31 days'`);
    }
    await buildGlobalEventSummaryTick({ prisma, now: () => new Date() })();
    const requests = await prisma.$queryRawUnsafe(`SELECT id,work_id FROM durable_global_event_capture_requests`);
    assert.deepEqual(requests.map((row) => row.work_id), [pendingWork.id]);
    const [pins] = await prisma.$queryRawUnsafe(`SELECT count(*)::int AS count FROM durable_capture_fact_pins
      WHERE owner_id=$1::uuid`, requests[0].id);
    assert.ok(pins.count > 0, "pending captures must keep their original fact versions pinned");
    for (const table of ["durable_capture_prepared_inputs", "durable_capture_method_progress"]) {
      const [remaining] = await prisma.$queryRawUnsafe(`SELECT count(*)::int AS count FROM ${table}`);
      assert.equal(remaining.count, 0);
    }
    assert.equal(await prisma.globalEventCaptureArtifact.count({ where: { workId: f.work.id } }), 1,
      "collecting retained inputs must not remove the published outcome");
  });

  it("runs bounded fact collection through the worker and can reconstruct a later capture", async () => {
    const f = await fixture();
    assert.equal((await sync(f, 200)).status, 202);
    await finishCapture(f.work.id);
    await prisma.$executeRawUnsafe(`UPDATE durable_global_event_capture_requests
      SET completed_at=clock_timestamp()-interval '31 days' WHERE work_id=$1`, f.work.id);
    await prisma.$executeRawUnsafe(`UPDATE durable_capture_fact_roots
      SET retention_expires_at=clock_timestamp()-interval '1 day',last_used_at=clock_timestamp()-interval '31 days'`);
    for (let tick = 0; tick < 8; tick++) {
      await buildGlobalEventSummaryTick({ prisma, now: () => new Date() })();
    }
    const [remaining] = await prisma.$queryRawUnsafe("SELECT count(*)::int AS count FROM durable_capture_fact_roots");
    assert.equal(remaining.count, 0, "the worker must invoke fact collection, not only remove owner records");
    assert.equal(await prisma.stepSample.count({ where: { userId: f.account.user.id } }), 1,
      "collecting retained versions must not remove source steps");
    const nextWork = await repeatEventWork(f);
    assert.equal((await sync(f, 200)).status, 202);
    assert.equal((await finishCapture(nextWork.id)).payload.attributionDeltaSteps, 200);
  });

  it("scores Hitchhike v3 from captured inputs without writing live checkpoints", async () => {
    const f = await fixture();
    const donor = await createTestUser({ displayName: "Hitchhike captured donor" });
    await prisma.race.update({ where: { id: f.race.id }, data: { powerupsEnabled: true } });
    await prisma.raceParticipant.create({ data: {
      raceId: f.race.id, userId: donor.user.id, status: "ACCEPTED", joinedAt: f.race.startedAt,
    } });
    assert.equal((await sync({ ...f, account: donor }, 200)).status, 202);
    const caster = await prisma.raceParticipant.findFirstOrThrow({ where: {
      raceId: f.race.id, userId: f.account.user.id,
    } });
    const target = await prisma.raceParticipant.findFirstOrThrow({ where: {
      raceId: f.race.id, userId: donor.user.id,
    } });
    const powerup = await prisma.racePowerup.create({ data: {
      raceId: f.race.id, participantId: caster.id, userId: f.account.user.id,
      targetUserId: donor.user.id, type: "HITCHHIKE", status: "USED",
    } });
    const effect = await prisma.raceActiveEffect.create({ data: {
      raceId: f.race.id, targetParticipantId: target.id, targetUserId: donor.user.id,
      sourceUserId: f.account.user.id, powerupId: powerup.id, type: "HITCHHIKE", status: "ACTIVE",
      startsAt: f.startsAt, expiresAt: f.endsAt, metadata: { copyRatio: 1, scoringVersion: 3 },
    } });
    assert.equal((await sync(f, 100)).status, 202);
    assert.equal(await prisma.hitchhikeAttributionCapture.count({ where: { effectId: effect.id } }), 0);
    const artifact = await finishCapture(f.work.id);
    assert.equal(artifact.payload.attributionDeltaSteps, 100);
    assert.equal(await prisma.hitchhikeAttributionCapture.count({ where: { effectId: effect.id } }), 0,
      "counterfactual summary scoring must never create or mutate live Hitchhike checkpoints");
    const nextWork = await repeatEventWork(f);
    const checkpoint = await prisma.hitchhikeAttributionCapture.create({ data: {
      effectId: effect.id, raceId: f.race.id, sourceUserId: f.account.user.id, targetUserId: donor.user.id,
      scoringVersion: 3, raceTimezone: "UTC", castDayStart: new Date(`${f.localDate}T00:00:00.000Z`),
      castDailySteps: 0, castSampleBoundaryAt: f.startsAt, scoringInputGeneration: 1n,
      rawSourceKind: "EXACT_SAMPLES", rawSourceHighWater: 200,
      effectiveContribution: -750, captureThrough: f.endsAt, frozenAt: f.endsAt,
    } });
    assert.equal((await sync(f, 100)).status, 202);
    const [acceptedCheckpoint] = await prisma.$queryRawUnsafe(
      "SELECT context FROM durable_global_event_capture_requests WHERE work_id=$1", nextWork.id);
    const capturedCheckpoint = acceptedCheckpoint.context.captures[0].payload.hitchhikeCaptures[0];
    for (const field of ["castDayStart", "castSampleBoundaryAt", "captureThrough", "frozenAt", "createdAt", "updatedAt"]) {
      assert.equal(capturedCheckpoint[field], checkpoint[field].toISOString(),
        `${field} must remain an explicit UTC instant on workers in any host timezone`);
    }
    await prisma.hitchhikeAttributionCapture.update({ where: { effectId: effect.id },
      data: { effectiveContribution: 1000 } });
    const laterLive = await prisma.hitchhikeAttributionCapture.findUniqueOrThrow({ where: { effectId: effect.id } });
    const pinned = await finishCapture(nextWork.id);
    assert.equal(pinned.payload.attributionDeltaSteps, 0,
      "the accepted negative frozen copy floors both scenarios to zero despite a later checkpoint change");
    assert.deepEqual(await prisma.hitchhikeAttributionCapture.findUniqueOrThrow({ where: { effectId: effect.id } }), laterLive,
      "both counterfactuals must leave the newer live checkpoint byte-for-byte unchanged");
    for (const scenario of [
      { coarseRaw: 500, expectedDelta: 0, label: "larger coarse source retains its signed contribution" },
      { coarseRaw: 200, expectedDelta: 100, label: "exact source wins a raw-source tie" },
    ]) {
      const boundaryWork = await repeatEventWork(f);
      await prisma.hitchhikeAttributionCapture.update({ where: { effectId: effect.id }, data: {
        frozenAt: null, coarseRawAttributed: scenario.coarseRaw, coarseEffectiveContribution: -750,
        effectiveContribution: 200,
      } });
      assert.equal((await sync(f, 100)).status, 202);
      const beforeScoring = await prisma.hitchhikeAttributionCapture.findUniqueOrThrow({ where: { effectId: effect.id } });
      const result = await finishCapture(boundaryWork.id);
      assert.equal(result.payload.attributionDeltaSteps, scenario.expectedDelta, scenario.label);
      assert.deepEqual(await prisma.hitchhikeAttributionCapture.findUniqueOrThrow({ where: { effectId: effect.id } }), beforeScoring);
    }
  });

  for (const corruption of ["prepared answer", "saved cursor"]) {
    it(`rejects a corrupt ${corruption} instead of signing a wrong summary`, async () => {
      const f = await fixture();
      assert.equal((await sync(f, 200)).status, 202);
      await finishCapture(f.work.id);
      const work = await repeatEventWork(f);
      if (corruption === "prepared answer") {
        const changed = await prisma.$executeRawUnsafe(`UPDATE durable_capture_prepared_inputs
          SET answers=(SELECT jsonb_object_agg(key,'999999'::jsonb) FROM jsonb_each(answers))
          WHERE user_id=$1`, f.account.user.id);
        assert.ok(changed > 0);
      } else {
        await prisma.$executeRawUnsafe("DELETE FROM durable_capture_prepared_inputs WHERE user_id=$1", f.account.user.id);
        // Evict both completed-answer layers to exercise recovery from the
        // saved cursor rather than satisfy this request from a valid answer.
        await prisma.$executeRawUnsafe("DELETE FROM durable_capture_interval_projections WHERE user_id=$1", f.account.user.id);
        const changed = await prisma.$executeRawUnsafe(`UPDATE durable_capture_method_progress
          SET state=jsonb_set(state,'{rootIndex}','999999'::jsonb) WHERE user_id=$1`, f.account.user.id);
        assert.ok(changed > 0);
      }
      assert.equal((await sync(f, 200)).status, 202);
      let status;
      for (let tick = 0; tick < 80; tick++) {
        await buildGlobalEventSummaryTick({ prisma, now: () => new Date() })();
        const [capture] = await prisma.$queryRawUnsafe(`SELECT status FROM durable_global_event_capture_requests
          WHERE work_id=$1`, work.id);
        status = capture.status;
        if (["FAILED", "COMPLETE"].includes(status)) break;
      }
      assert.equal(status, "FAILED");
      assert.equal(await prisma.globalEventCaptureArtifact.count({ where: { workId: work.id } }), 0);
    });
  }

  it("reuses prepared scoring inputs across event captures without reloading immutable history", async () => {
    const f = await fixture();
    assert.equal((await sync(f, 200)).status, 202);
    await finishCapture(f.work.id);
    const nextEvent = await prisma.globalStepEvent.create({ data: {
      startsAt: f.startsAt, endsAt: f.endsAt, multiplier: 3, summaryAttributionVersion: 2,
    } });
    await prisma.globalStepEventEntitlement.create({ data: {
      eventId: nextEvent.id, userId: f.account.user.id, timezone: "UTC", localDate: f.localDate,
      startsAt: f.startsAt, endsAt: f.endsAt, startOutcome: "ACTIVATED_ON_TIME", startProcessedAt: f.startsAt,
    } });
    const work = await prisma.globalEventSummaryWork.create({ data: {
      eventId: nextEvent.id, userId: f.account.user.id, status: "WAITING_SYNC",
      expiresAt: new Date(Date.now() + 3600_000), requiredRaceCount: 1,
    } });
    await prisma.globalEventRaceImpact.create({ data: {
      eventId: nextEvent.id, raceId: f.race.id, userId: f.account.user.id,
      status: "PENDING", attributionVersion: 2,
    } });
    assert.equal((await sync(f, 200)).status, 202);
    metrics.reset();
    const artifact = await finishCapture(work.id);
    assert.equal(artifact.payload.attributionDeltaSteps, 400,
      "reuse must preserve event-specific multipliers, not cache another event's outcome");
    assert.equal(metrics.snapshot().histograms.global_summary_capture_durable_fact_bytes?.sum || 0, 0,
      "unchanged facts must reuse prepared inputs, not reload the same immutable history");
  });

  it("reuses event-window samples after an unrelated same-day upload", async () => {
    const f = await fixture();
    assert.equal((await sync(f, 200)).status, 202);
    await finishCapture(f.work.id);
    const laterStart = new Date(f.endsAt.getTime() + 1000);
    const laterEnd = new Date(f.endsAt.getTime() + 61000);
    assert.equal(laterStart.toISOString().slice(0, 10), f.endsAt.toISOString().slice(0, 10));
    const later = await request(server.baseUrl, "POST", "/steps/sync-v2", {
      token: f.account.token, headers: headers(), body: { date: f.localDate, steps: 500,
        samples: [{ periodStart: laterStart.toISOString(), periodEnd: laterEnd.toISOString(),
          steps: 300, recordingMethod: "automatic" }],
      },
    });
    assert.equal(later.status, 202);
    const work = await repeatEventWork(f);
    assert.equal((await sync(f, 200)).status, 202);
    metrics.reset();
    const artifact = await finishCapture(work.id);
    assert.equal(artifact.payload.attributionDeltaSteps, 200);
    assert.equal(metrics.snapshot().histograms.global_summary_capture_durable_fact_bytes?.sum || 0, 0,
      "a changed UTC-day root outside the event window must not invalidate prepared sample answers");
  });

  it("shares prepared facts between different uploaders in a connected race", async () => {
    const f = await fixture();
    const other = await createTestUser({ displayName: "Shared input participant" });
    await prisma.race.update({ where: { id: f.race.id }, data: { powerupsEnabled: true } });
    const participant = await prisma.raceParticipant.create({ data: {
      raceId: f.race.id, userId: other.user.id, status: "ACCEPTED", joinedAt: f.race.startedAt,
    } });
    const target = await prisma.raceParticipant.findFirstOrThrow({ where: {
      raceId: f.race.id, userId: f.account.user.id,
    } });
    const powerup = await prisma.racePowerup.create({ data: {
      raceId: f.race.id, participantId: participant.id, userId: other.user.id,
      targetUserId: f.account.user.id, type: "LEECH", status: "USED",
    } });
    await prisma.raceActiveEffect.create({ data: {
      raceId: f.race.id, targetParticipantId: target.id, targetUserId: f.account.user.id,
      sourceUserId: other.user.id, powerupId: powerup.id, type: "LEECH", status: "ACTIVE",
      startsAt: f.startsAt, expiresAt: f.endsAt, metadata: { ratio: 2 },
    } });
    const second = { ...f, account: other };
    assert.equal((await sync(second, 300)).status, 202);
    await prisma.globalStepEventEntitlement.create({ data: {
      eventId: f.event.id, userId: other.user.id, timezone: "UTC", localDate: f.localDate,
      startsAt: f.startsAt, endsAt: f.endsAt, startOutcome: "ACTIVATED_ON_TIME", startProcessedAt: f.startsAt,
    } });
    const work = await prisma.globalEventSummaryWork.create({ data: {
      eventId: f.event.id, userId: other.user.id, status: "WAITING_SYNC",
      expiresAt: new Date(Date.now() + 3600_000), requiredRaceCount: 1,
    } });
    await prisma.globalEventRaceImpact.create({ data: {
      eventId: f.event.id, raceId: f.race.id, userId: other.user.id,
      status: "PENDING", attributionVersion: 2,
    } });
    assert.equal((await sync(f, 200)).status, 202);
    await finishCapture(f.work.id);
    assert.equal((await sync(second, 300)).status, 202);
    metrics.reset();
    const artifact = await finishCapture(work.id);
    assert.equal(artifact.payload.attributionDeltaSteps, 300);
    assert.equal(metrics.snapshot().histograms.global_summary_capture_durable_fact_bytes?.sum || 0, 0,
      "a different uploader must share unchanged dependency inputs durably");
    const [owner] = await prisma.$queryRawUnsafe(`SELECT id FROM durable_global_event_capture_requests
      WHERE work_id=$1`, f.work.id);
    const deletion = await request(server.baseUrl, "DELETE", "/auth/account", { token: f.account.token });
    assert.equal(deletion.status, 204);
    const [remaining] = await prisma.$queryRawUnsafe(`SELECT count(*)::int AS count
      FROM durable_capture_fact_pins WHERE owner_id=$1::uuid`, owner.id);
    assert.equal(remaining.count, 0, "account deletion must not orphan pins on another user's shared facts");
  });
});
