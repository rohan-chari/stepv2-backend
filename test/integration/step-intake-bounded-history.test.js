const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { before, beforeEach, describe, it } = require("node:test");
const { Client } = require("pg");
const { prisma, cleanDatabase, createTestUser, getSharedServer, request } = require("./setup");

let baseUrl;
async function sync(account, sample, steps = 100) {
  return request(baseUrl, "POST", "/steps/sync-v2", {
    token: account.token, headers: { "Idempotency-Key": randomUUID(), "X-Timezone": "UTC" },
    body: { date: new Date().toISOString().slice(0,10), steps, samples: sample ? [sample] : [] },
  });
}
async function fixture() {
  const account = await createTestUser();
  const oldStart = Date.now() - 10 * 86400000;
  await prisma.stepSample.createMany({ data: Array.from({ length: 512 }, (_, i) => ({
    userId: account.user.id, periodStart: new Date(oldStart + i * 60000),
    periodEnd: new Date(oldStart + (i + 1) * 60000), steps: 1,
  })) });
  const sample = { periodStart: new Date(Date.now()-7200000).toISOString(),
    periodEnd: new Date(Date.now()-3600000).toISOString(), steps: 100, sourceName: "Original" };
  const race = await prisma.race.create({ data: { creatorId: account.user.id, name: "Bounded intake",
    status: "ACTIVE", targetSteps: 100000, maxParticipants: 10,
    startedAt: new Date(Date.now()-86400000), endsAt: new Date(Date.now()+86400000), timezone: "UTC" } });
  await prisma.raceParticipant.create({ data: { raceId: race.id, userId: account.user.id, status: "ACCEPTED" } });
  assert.equal((await sync(account, sample)).status, 202);
  return { account, sample, race };
}
function observeSampleReads(t) {
  const reads = [];
  const original = Client.prototype.query;
  t.mock.method(Client.prototype, "query", function (...args) {
    const sql = typeof args[0] === "string" ? args[0] : args[0].text;
    const result = original.apply(this, args);
    if (/SELECT/i.test(sql) && /step_samples/i.test(sql) && result?.then) {
      return result.then(value => { reads.push({ sql, rows: value.rows.length }); return value; });
    }
    return result;
  });
  return reads;
}
const version = userId => prisma.userScoringInputVersion.findUniqueOrThrow({ where: { userId } });
const job = raceId => prisma.raceResolutionJobV2.findUniqueOrThrow({ where: { raceId } });

describe("bounded sample history through public step intake", () => {
  before(async () => { baseUrl = (await getSharedServer()).baseUrl; });
  beforeEach(cleanDatabase);
  for (const mode of ["changed", "identical", "metadata-only", "daily-only"]) {
    it(`${mode} intake does not hydrate unrelated retained history`, async (t) => {
      const { account, sample, race } = await fixture();
      const before = await version(account.user.id);
      const beforeJob = await job(race.id);
      const reads = observeSampleReads(t);
      let response;
      if (mode === "daily-only") {
        response = await request(baseUrl, "POST", "/steps", { token: account.token,
          body: { date: new Date().toISOString().slice(0,10), steps: 100 } });
        assert.equal(response.status, 200);
      } else {
        response = await sync(account, { ...sample,
          ...(mode === "changed" ? { steps: 101 } : {}),
          ...(mode === "metadata-only" ? { sourceName: "Updated device name" } : {}),
        });
        assert.equal(response.status, 202);
      }
      const after = await version(account.user.id);
      const afterJob = await job(race.id);
      if (mode === "changed") {
        assert.equal(after.generation, before.generation + 1n);
        assert.ok(afterJob.generation > beforeJob.generation);
      } else {
        assert.equal(after.generation, before.generation, "unchanged scoring must not enqueue another generation");
        assert.equal(afterJob.generation, beforeJob.generation);
      }
      if (mode === "metadata-only") {
        const row = await prisma.stepSample.findUniqueOrThrow({ where: { userId_periodStart: {
          userId: account.user.id, periodStart: new Date(sample.periodStart) } } });
        assert.equal(row.sourceName, "Updated device name");
      }
      assert.ok(reads.length > 0, "observer must capture real sample reads");
      assert.ok(reads.every(read => read.rows <= 8), `single-window intake returned historical rows: ${reads.map(r => r.rows)}`);
      assert.ok(!reads.some(read => /WITH decision_clock/i.test(read.sql)), "normal intake must not invoke full-history hashing");
    });
  }

  it("legacy fingerprints transition conservatively once without hydrating history", async (t) => {
    const { account, sample } = await fixture();
    await prisma.userScoringInputVersion.update({ where: { userId: account.user.id }, data: { scoringWatermark: "a".repeat(64) } });
    const before = await version(account.user.id);
    const reads = observeSampleReads(t);
    assert.equal((await sync(account, sample)).status, 202);
    const migrated = await version(account.user.id);
    assert.equal(migrated.generation, before.generation + 1n);
    assert.match(migrated.scoringWatermark, /^v2:[a-f0-9]{61}$/);
    assert.equal((await sync(account, sample)).status, 202);
    assert.equal((await version(account.user.id)).generation, migrated.generation);
    assert.ok(reads.every(read => read.rows <= 8));
  });

  it("an elapsed persisted sample boundary triggers one scoring generation even for identical input", async () => {
    const { account, sample, race } = await fixture();
    await prisma.userScoringInputVersion.update({ where: { userId: account.user.id },
      data: { nextSampleBoundaryAt: new Date(Date.now()-1000) } });
    const before = await version(account.user.id);
    const beforeJob = await job(race.id);
    assert.equal((await sync(account, sample)).status, 202);
    const after = await version(account.user.id);
    assert.equal(after.generation, before.generation+1n);
    assert.equal(after.nextSampleBoundaryAt, null);
    assert.ok((await job(race.id)).generation > beforeJob.generation);
    assert.equal((await sync(account, sample)).status, 202);
    assert.equal((await version(account.user.id)).generation, after.generation);
  });

  it("a stale queue handoff is repaired on identical input without changing scoring generation", async () => {
    const { account, sample, race } = await fixture();
    const before = await version(account.user.id);
    const beforeJob = await job(race.id);
    await prisma.userScoringInputVersion.update({ where: { userId: account.user.id }, data: { sourceQueueSemanticsGeneration: null } });
    assert.equal((await sync(account, sample)).status, 202);
    const after = await version(account.user.id);
    assert.equal(after.generation, before.generation);
    assert.equal(after.sourceQueueSemanticsGeneration, after.generation);
    assert.ok((await job(race.id)).generation > beforeJob.generation);
  });

  it("concurrent identical corrections advance scoring only once", async () => {
    const { account, sample } = await fixture();
    const before = await version(account.user.id);
    const corrected = { ...sample, steps: 120 };
    const responses = await Promise.all([sync(account, corrected), sync(account, corrected)]);
    assert.deepEqual(responses.map(r => r.status), [202,202]);
    assert.equal((await version(account.user.id)).generation, before.generation+1n);
  });

  it("same step total with changed intervals is not a scoring no-op", async () => {
    const { account, sample } = await fixture();
    const before = await version(account.user.id);
    const middle = new Date((new Date(sample.periodStart).getTime()+new Date(sample.periodEnd).getTime())/2).toISOString();
    const response = await request(baseUrl, "POST", "/steps/samples", { token: account.token,
      body: { samples: [{ ...sample, periodEnd: middle, steps: 50 }, { ...sample, periodStart: middle, steps: 50 }] } });
    assert.equal(response.status, 200);
    assert.equal((await version(account.user.id)).generation, before.generation+1n);
  });

  it("a rejected coarser upload preserves scoring generation without reading history", async (t) => {
    const { account, sample } = await fixture();
    const before = await version(account.user.id);
    const reads = observeSampleReads(t);
    const coarse = { ...sample, periodStart: new Date(new Date(sample.periodStart).getTime()-3600000).toISOString(), steps: 999 };
    assert.equal((await sync(account, coarse)).status, 202);
    assert.equal((await version(account.user.id)).generation, before.generation);
    assert.ok(reads.every(read => read.rows <= 8));
  });

  it("shortening the latest sample moves persisted capture coverage backward", async () => {
    const { account, sample } = await fixture();
    // The span guard intentionally protects credited overhang. A zero-credit
    // row can legitimately be shortened, exercising a decreasing MAX(end).
    assert.equal((await sync(account, { ...sample, steps: 0 })).status, 202);
    const end = new Date(new Date(sample.periodEnd).getTime()-1800000).toISOString();
    assert.equal((await sync(account, { ...sample, periodEnd: end, steps: 0 })).status, 202);
    const row = await prisma.stepSyncRequest.findFirst({ where: { userId: account.user.id }, orderBy: { createdAt: "desc" } });
    assert.equal(row.canonicalCoverageThrough.toISOString(), end);
  });

  it("retention invalidates the revision and the next HTTP intake repairs queue ownership", async (t) => {
    const { account, sample, race } = await fixture();
    const before = await version(account.user.id);
    const beforeJob = await job(race.id);
    const old = await prisma.stepSample.create({ data: {
      userId: account.user.id, periodStart: new Date(Date.now()-61*86400000),
      periodEnd: new Date(Date.now()-60*86400000), steps: 10,
    } });
    // Retention has no HTTP entrypoint: execute the real scheduled callback
    // with its real DB claim, then exercise intake through the public route.
    const { buildCleanupStepSamples, JOB_NAME } = require("../../src/modules/steps/jobs/stepSampleRetention");
    // cleanDatabase deliberately preserves scheduler markers. Reset only this
    // callback's marker in the dedicated test DB so repeated test runs execute.
    await prisma.jobRun.deleteMany({ where: { jobName: JOB_NAME } });
    t.after(() => prisma.jobRun.deleteMany({ where: { jobName: JOB_NAME } }));
    const cleanup = await buildCleanupStepSamples({ targetHour: 0, disabled: false, logger: { log() {} } })();
    assert.ok(cleanup.count >= 1);
    assert.equal(await prisma.stepSample.findUnique({ where: { id: old.id } }), null);
    const pruned = await version(account.user.id);
    assert.equal(pruned.generation, before.generation+1n);
    assert.equal(pruned.scoringWatermark, before.scoringWatermark);
    const reads = observeSampleReads(t);
    assert.equal((await sync(account, sample)).status, 202);
    const repaired = await version(account.user.id);
    assert.equal(repaired.sourceQueueSemanticsGeneration, repaired.generation);
    assert.notEqual(repaired.scoringWatermark, pruned.scoringWatermark);
    assert.ok((await job(race.id)).generation > beforeJob.generation);
    assert.ok(reads.every(read => read.rows <= 8));
    assert.equal((await sync(account, sample)).status, 202);
    assert.equal((await version(account.user.id)).generation, repaired.generation);
  });

  it("bootstrap without samples has null coverage and repeated daily input stays a no-op", async (t) => {
    const account = await createTestUser();
    const reads = observeSampleReads(t);
    assert.equal((await sync(account, null)).status, 202);
    const before = await version(account.user.id);
    const first = await prisma.stepSyncRequest.findFirstOrThrow({ where: { userId: account.user.id } });
    assert.equal(first.canonicalCoverageThrough, null);
    assert.equal(before.nextSampleBoundaryAt, null);
    assert.equal((await sync(account, null)).status, 202);
    assert.equal((await version(account.user.id)).generation, before.generation);
    assert.ok(reads.every(read => read.rows <= 1));
  });

  it("future-ended samples persist the earliest boundary and latest capture coverage", async () => {
    const { account } = await fixture();
    const near = new Date(Date.now()+600000).toISOString();
    const far = new Date(Date.now()+1200000).toISOString();
    const samples = [
      { periodStart: new Date(Date.now()-600000).toISOString(), periodEnd: near, steps: 20 },
      { periodStart: near, periodEnd: far, steps: 0 },
    ];
    assert.equal((await request(baseUrl, "POST", "/steps/sync-v2", {
      token: account.token, headers: { "Idempotency-Key": randomUUID(), "X-Timezone": "UTC" },
      body: { date: new Date().toISOString().slice(0,10), steps: 100, samples },
    })).status, 202);
    const current = await version(account.user.id);
    assert.equal(current.nextSampleBoundaryAt.toISOString(), near);
    const row = await prisma.stepSyncRequest.findFirstOrThrow({ where: { userId: account.user.id }, orderBy: { createdAt: "desc" } });
    assert.equal(row.canonicalCoverageThrough.toISOString(), far);
    assert.equal((await sync(account, null)).status, 202);
    assert.equal((await version(account.user.id)).generation, current.generation);
  });

  it("the observed bounds statement uses limited indexed lookups rather than sorting history", async (t) => {
    const { account, sample } = await fixture();
    // A shared integration DB has changing planner statistics. Model a real
    // multi-user table and refresh its statistics, without forcing an index.
    const peers = Array.from({ length: 32 }, () => ({ id: randomUUID(), appleId: randomUUID() }));
    await prisma.user.createMany({ data: peers });
    await prisma.$executeRawUnsafe(`INSERT INTO step_samples (id,user_id,period_start,period_end,steps)
      SELECT gen_random_uuid()::text,peer.user_id,
             timestamp '2026-01-01' + n * interval '1 minute',
             timestamp '2026-01-01' + (n+1) * interval '1 minute',1
      FROM unnest($1::text[]) AS peer(user_id) CROSS JOIN generate_series(0,511) AS n`, peers.map(peer => peer.id));
    await prisma.$executeRawUnsafe("ANALYZE step_samples");
    const reads = observeSampleReads(t);
    assert.equal((await sync(account, sample)).status, 202);
    const bound = reads.find(read => /WITH decision_time AS/i.test(read.sql));
    assert.ok(bound, "HTTP intake must execute the bounds read");
    const plan = await prisma.$queryRawUnsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${bound.sql}`, account.user.id);
    const root = plan[0]["QUERY PLAN"][0].Plan;
    const nodes = [];
    const visit = node => { nodes.push(node); (node.Plans || []).forEach(visit); };
    visit(root);
    const sampleScans = nodes.filter(node => node["Relation Name"] === "step_samples");
    assert.equal(sampleScans.length, 2);
    for (const scan of sampleScans) {
      assert.match(scan["Node Type"], /Index/);
      assert.ok(scan["Actual Rows"] <= 1);
      assert.match(scan["Index Cond"], /user_id/);
    }
    assert.ok(!nodes.some(node => node["Node Type"] === "Sort"));
  });

  for (const name of ["reset-app-review.sql", "seed-app-review-demo.sql"]) {
    it(`${name} SQL fence invalidates a current revision before the next HTTP sync`, async () => {
      const { account, sample, race } = await fixture();
      const before = await version(account.user.id);
      const beforeJob = await job(race.id);
      const sql = readFileSync(path.join(__dirname, "../../scripts", name), "utf8");
      const start = sql.indexOf("INSERT INTO user_scoring_input_versions");
      const fence = sql.slice(start, sql.indexOf(";", start)+1);
      // Execute the exact script fence in PostgreSQL. The complete demo script
      // also seeds unrelated cosmetics/races; this test isolates its input-write
      // transaction, which has no HTTP entrypoint.
      await prisma.$transaction(async tx => {
        if (name.startsWith("reset")) {
          await tx.$executeRawUnsafe("CREATE TEMP TABLE review_user_ids (id text) ON COMMIT DROP");
          await tx.$executeRawUnsafe("INSERT INTO review_user_ids VALUES ($1)", account.user.id);
          await tx.$executeRawUnsafe(fence);
        } else {
          const others = await Promise.all([createTestUser(), createTestUser(), createTestUser()]);
          await tx.$executeRawUnsafe(fence.replace("ARRAY[demo_user_id, alex_id, maya_id, jordan_id]", "$1::text[]"),
            [account.user.id, ...others.map(other => other.user.id)]);
        }
        await tx.$executeRawUnsafe("UPDATE step_samples SET steps=steps+1 WHERE user_id=$1 AND period_end<$2::timestamp",
          account.user.id, sample.periodStart);
      });
      const invalidated = await version(account.user.id);
      assert.equal(invalidated.generation, before.generation+1n);
      assert.equal(invalidated.scoringWatermark, before.scoringWatermark);
      assert.equal((await sync(account, sample)).status, 202);
      const repaired = await version(account.user.id);
      assert.equal(repaired.sourceQueueSemanticsGeneration, repaired.generation);
      assert.notEqual(repaired.scoringWatermark, before.scoringWatermark);
      assert.ok((await job(race.id)).generation > beforeJob.generation);
    });
  }
});
