const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { describe, it, before, beforeEach, after } = require("node:test");
process.env.PRISMA_QUERY_EVENTS_ENABLED = "true";
const { getSharedServer, cleanDatabase, createTestUser, request, prisma } = require("./setup");

// Real HTTP intake, real transactions, and real query events. No queue/scorer
// utilities are called: the public upload must perform the durable fan-out.
describe("step sync batches large-race durable fan-out", () => {
  let baseUrl;
  let queries = null;
  const settingKeys = ["raceResolutionQueuedGenerationMergeV1Enabled", "raceResolutionBurstCoalescingV1Enabled"];
  let priorSettings;
  before(async () => {
    priorSettings = await prisma.appSetting.findMany({ where: { key: { in: settingKeys } } });
    // Node's historical test defaults differ from permanent production behavior.
    // Seed production configuration before the server's first settings read.
    for (const key of settingKeys) await prisma.appSetting.upsert({
      where: { key }, create: { key, value: true }, update: { value: true },
    });
    baseUrl = (await getSharedServer()).baseUrl;
    prisma.$on("query", (event) => { if (queries) queries.push(event.query); });
  });
  after(async () => {
    await prisma.appSetting.deleteMany({ where: { key: { in: settingKeys } } });
    if (priorSettings?.length) await prisma.appSetting.createMany({ data: priorSettings });
  });
  beforeEach(cleanDatabase);

  async function racesFor(users, capacities) {
    const startedAt = new Date(Date.now() - 3_600_000);
    const races = capacities.map((maxParticipants) => ({
      id: randomUUID(), creatorId: users[0].id, name: "Batch fan-out",
      targetSteps: 0, timeBased: true, timezone: "UTC", maxParticipants,
      maxDurationDays: 7, status: "ACTIVE", startedAt,
      endsAt: new Date(Date.now() + 86_400_000),
    }));
    await prisma.race.createMany({ data: races });
    await prisma.raceParticipant.createMany({ data: races.flatMap((race) => users.map((user) => ({
      id: randomUUID(), raceId: race.id, userId: user.id,
      status: "ACCEPTED", joinedAt: startedAt,
    }))) });
    return races.sort((a, b) => a.id.localeCompare(b.id));
  }

  async function upload(token, steps = 100, key = randomUUID()) {
    const response = await request(baseUrl, "POST", "/steps/sync-v2", {
      token, headers: { "Idempotency-Key": key },
      body: { date: new Date().toISOString().slice(0, 10), steps, samples: [] },
    });
    return { status: response.status, body: await response.json() };
  }

  async function measuredUpload(token, steps) {
    queries = [];
    try {
      const result = await upload(token, steps);
      return { ...result, statements: [...queries] };
    } finally { queries = null; }
  }

  function queueStatements(statements) {
    return statements.filter((sql) => /\b(?:FROM|INTO|UPDATE)\s+"?race_resolution_(?:full_triggers|jobs_v2)"?\b/i.test(sql));
  }

  async function assertHandoff(user, races, result, triggerCount = 1) {
    assert.equal(result.status, 202, JSON.stringify(result.body));
    const jobs = await prisma.raceResolutionJobV2.findMany({ orderBy: { raceId: "asc" } });
    assert.equal(jobs.length, races.length);
    assert.equal(result.body.raceResolution.jobId, jobs[0].id);
    assert.equal(result.body.raceResolution.generation, jobs[0].generation);
    const participants = await prisma.raceParticipant.findMany({ where: { userId: user.id } });
    const triggers = await prisma.raceResolutionFullTrigger.findMany({ where: { userId: user.id } });
    const large = races.filter((race) => race.maxParticipants == null || race.maxParticipants > 1000);
    assert.equal(triggers.length, large.length * triggerCount);
    for (const race of large) {
      const matching = triggers.filter((row) => row.raceId === race.id);
      assert.equal(matching.length, triggerCount);
      for (const row of matching) {
        assert.equal(row.participantId, race.maxParticipants == null ? null : participants.find((p) => p.raceId === race.id).id);
      }
    }
    return jobs;
  }

  it("creates ten new race jobs and scoped triggers in a bounded number of statements", async () => {
    const { user, token } = await createTestUser();
    const races = await racesFor([user], Array(10).fill(10_000));
    const result = await measuredUpload(token, 100);
    const jobs = await assertHandoff(user, races, result);
    for (const job of jobs) {
      assert.equal(job.generation, 1);
      assert.equal(job.state, "QUEUED");
      assert.equal(job.fullTriggerSeedOnly, true);
      assert.deepEqual(job.dirtyReasons, ["FULL"]);
      assert.deepEqual(job.triggeredByUserIds, []);
      assert.equal(job.notBeforeAt.getTime() - job.requestedAt.getTime(), 5000);
    }
    assert.ok(queueStatements(result.statements).length <= 4,
      `ten races took ${queueStatements(result.statements).length} queue statements; expected <=4`);
  });

  it("appends for queued/running jobs in two statements without altering claims or debounce", async () => {
    const { user, token } = await createTestUser();
    const races = await racesFor([user], Array(10).fill(10_000));
    assert.equal((await upload(token)).status, 202);
    await prisma.raceResolutionJobV2.updateMany({ where: { raceId: { in: races.slice(0, 5).map((r) => r.id) } },
      data: { state: "RUNNING", processingGeneration: 1, leaseToken: "held-claim", leaseExpiresAt: new Date(Date.now() + 60_000) } });
    const beforeJobs = await prisma.raceResolutionJobV2.findMany({ orderBy: { raceId: "asc" } });
    const result = await measuredUpload(token, 200);
    const jobs = await assertHandoff(user, races, result, 2);
    assert.deepEqual(jobs, beforeJobs);
    assert.equal(queueStatements(result.statements).length, 2);
  });

  it("reactivates terminal jobs once and retains active jobs in a mixed batch", async () => {
    const { user, token } = await createTestUser();
    const races = await racesFor([user], Array(8).fill(10_000));
    assert.equal((await upload(token)).status, 202);
    for (const [index, state] of [[0, "SUCCEEDED"], [1, "FAILED"]]) {
      await prisma.raceResolutionJobV2.update({ where: { raceId: races[index].id },
        data: { state, attempts: 3, lastErrorCode: "old-error", retryAt: new Date() } });
    }
    const result = await measuredUpload(token, 200);
    const jobs = await assertHandoff(user, races, result, 2);
    for (let i = 0; i < jobs.length; i += 1) {
      assert.equal(jobs[i].generation, i < 2 ? 2 : 1);
      assert.equal(jobs[i].state, "QUEUED");
      assert.equal(jobs[i].attempts, 0);
      assert.equal(jobs[i].retryAt, null);
      assert.equal(jobs[i].lastErrorCode, null);
    }
    assert.ok(queueStatements(result.statements).length <= 4);
  });

  it("preserves ordinary-race scope alongside batched large and unbounded races", async () => {
    const { user, token } = await createTestUser();
    const races = await racesFor([user], [10, 10_000, null, 10, 10_000]);
    const result = await upload(token);
    // Unbounded races intentionally retain the existing unscoped FULL fallback.
    assert.equal(result.status, 202);
    const jobs = await prisma.raceResolutionJobV2.findMany({ orderBy: { raceId: "asc" } });
    assert.equal(jobs.length, races.length);
    assert.equal(result.body.raceResolution.jobId, jobs[0].id);
    for (const job of jobs) {
      const race = races.find((r) => r.id === job.raceId);
      assert.deepEqual(job.dirtyReasons, race.maxParticipants === 10 ? ["STEP_INPUT_CHANGED"] : ["FULL"]);
      assert.deepEqual(job.triggeredByUserIds, race.maxParticipants === 10 ? [user.id] : []);
      assert.equal(job.fullTriggerSeedOnly, race.maxParticipants === 10_000);
    }
    const triggers = await prisma.raceResolutionFullTrigger.findMany();
    assert.equal(triggers.length, 3);
    const unbounded = triggers.find((row) => row.raceId === races.find((r) => r.maxParticipants == null).id);
    assert.equal(unbounded.userId, null);
    assert.equal(unbounded.participantId, null);
  });

  it("does not append on idempotent replay or a scoring no-op", async () => {
    const { user, token } = await createTestUser();
    const races = await racesFor([user], Array(3).fill(10_000));
    const key = randomUUID();
    const first = await upload(token, 100, key);
    const replay = await upload(token, 100, key);
    assert.equal(replay.status, 202);
    assert.deepEqual(replay.body, first.body);
    await assertHandoff(user, races, first);
    assert.equal((await upload(token, 100)).status, 202);
    assert.equal(await prisma.raceResolutionFullTrigger.count(), 3);
  });

  it("keeps every uploader's trigger across simultaneous overlapping fan-outs", async () => {
    const uploaders = await Promise.all(Array.from({ length: 4 }, () => createTestUser()));
    const races = await racesFor(uploaders.map((u) => u.user), Array(10).fill(10_000));
    const results = await Promise.all(uploaders.map(({ token }) => upload(token)));
    for (let i = 0; i < uploaders.length; i += 1) await assertHandoff(uploaders[i].user, races, results[i]);
    assert.equal(await prisma.raceResolutionFullTrigger.count(), 40);
    const jobs = await prisma.raceResolutionJobV2.findMany();
    assert.ok(jobs.every((job) => job.generation === 1));
  });

  it("does not wait on a worker holding an already active race job", async () => {
    const { user, token } = await createTestUser();
    const races = await racesFor([user], Array(3).fill(10_000));
    assert.equal((await upload(token)).status, 202);
    let unlock, acquired;
    const gate = new Promise((resolve) => { unlock = resolve; });
    const ready = new Promise((resolve) => { acquired = resolve; });
    const blocker = prisma.$transaction(async (tx) => {
      await tx.$queryRawUnsafe("SELECT id FROM race_resolution_jobs_v2 ORDER BY race_id FOR UPDATE");
      acquired();
      await gate;
    }, { timeout: 15_000 });
    await ready;
    let timer;
    const pending = upload(token, 200);
    try {
      const result = await Promise.race([pending, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("upload waited on an active race job lock")), 5000);
      })]);
      await assertHandoff(user, races, result, 2);
    } finally {
      clearTimeout(timer);
      unlock();
      await blocker;
      await pending;
    }
  });

  it("rolls back source inputs and all fan-out rows if a later race cannot be queued", async () => {
    const { user, token } = await createTestUser();
    const races = await racesFor([user], Array(3).fill(10_000));
    await prisma.$executeRawUnsafe(`CREATE FUNCTION test_reject_batch_queue() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.race_id = '${races[2].id}' THEN RAISE EXCEPTION 'batch test failure'; END IF; RETURN NEW; END $$`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER test_reject_batch_queue BEFORE INSERT ON race_resolution_jobs_v2
      FOR EACH ROW EXECUTE FUNCTION test_reject_batch_queue()`);
    try {
      const result = await upload(token);
      assert.equal(result.status, 500);
      assert.equal(await prisma.step.count({ where: { userId: user.id } }), 0);
      assert.equal(await prisma.raceResolutionFullTrigger.count(), 0);
      assert.equal(await prisma.raceResolutionJobV2.count(), 0);
    } finally {
      await prisma.$executeRawUnsafe("DROP TRIGGER test_reject_batch_queue ON race_resolution_jobs_v2");
      await prisma.$executeRawUnsafe("DROP FUNCTION test_reject_batch_queue()");
    }
  });

  it("keeps fan-out bounded across a page boundary without dropping or duplicating races", async () => {
    const { user, token } = await createTestUser();
    // Beyond the HTTP membership limit: protects shared queue callers as well.
    const races = await racesFor([user], Array(251).fill(10_000));
    const first = await measuredUpload(token, 100);
    await assertHandoff(user, races, first);
    assert.ok(queueStatements(first.statements).length <= 8);
    const second = await measuredUpload(token, 200);
    await assertHandoff(user, races, second, 2);
    assert.ok(queueStatements(second.statements).length <= 4);
  });

  async function waitForBlockedActivation() {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const [row] = await prisma.$queryRawUnsafe(`SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname=current_database() AND wait_event_type='Lock'
          AND query ILIKE '%INSERT INTO race_resolution_jobs_v2%'`);
      if (row.n > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail("the upload did not reach the blocked queue activation");
  }

  for (const blockedIndex of [0, 1]) {
    it(`acquires terminal queue locks in ascending order when blocked on race ${blockedIndex}`, async () => {
      const { user, token } = await createTestUser();
      const races = await racesFor([user], [10_000, 10_000]);
      assert.equal((await upload(token)).status, 202);
      await prisma.raceResolutionJobV2.updateMany({ data: { state: "SUCCEEDED" } });
      let unlock, acquired;
      const gate = new Promise((resolve) => { unlock = resolve; });
      const ready = new Promise((resolve) => { acquired = resolve; });
      const blocker = prisma.$transaction(async (tx) => {
        await tx.$queryRawUnsafe("SELECT id FROM race_resolution_jobs_v2 WHERE race_id=$1 FOR UPDATE", races[blockedIndex].id);
        acquired();
        await gate;
      }, { timeout: 15_000 });
      await ready;
      const pending = upload(token, 200);
      try {
        await waitForBlockedActivation();
        let otherLocked = false;
        try {
          await prisma.$transaction((tx) => tx.$queryRawUnsafe(
            "SELECT id FROM race_resolution_jobs_v2 WHERE race_id=$1 FOR UPDATE NOWAIT", races[1 - blockedIndex].id));
        } catch (error) {
          assert.match(error.message, /could not obtain lock/);
          otherLocked = true;
        }
        assert.equal(otherLocked, blockedIndex === 1);
      } finally {
        unlock();
        await blocker;
        assert.equal((await pending).status, 202);
      }
      assert.ok((await prisma.raceResolutionJobV2.findMany()).every((job) => job.generation === 2));
    });
  }

  it("returns the concurrent activation winner without overwriting its running claim", async () => {
    const { user, token } = await createTestUser();
    const races = await racesFor([user], [10_000, 10_000]);
    assert.equal((await upload(token)).status, 202);
    await prisma.raceResolutionJobV2.updateMany({ data: { state: "SUCCEEDED" } });
    let unlock, acquired;
    const gate = new Promise((resolve) => { unlock = resolve; });
    const ready = new Promise((resolve) => { acquired = resolve; });
    const blocker = prisma.$transaction(async (tx) => {
      // Uncommitted activation: upload's MVCC read still sees SUCCEEDED, then
      // waits on the upsert and must reread this winner after it commits.
      await tx.raceResolutionJobV2.update({ where: { raceId: races[0].id }, data: {
        state: "RUNNING", generation: 2, processingGeneration: 2,
        leaseToken: "concurrent-winner", leaseExpiresAt: new Date(Date.now() + 60_000),
      } });
      acquired();
      await gate;
    }, { timeout: 15_000 });
    await ready;
    const pending = upload(token, 200);
    try { await waitForBlockedActivation(); }
    finally { unlock(); await blocker; }
    const result = await pending;
    const jobs = await assertHandoff(user, races, result, 2);
    assert.equal(jobs[0].generation, 2);
    assert.equal(jobs[0].processingGeneration, 2);
    assert.equal(jobs[0].state, "RUNNING");
    assert.equal(jobs[0].leaseToken, "concurrent-winner");
    assert.equal(jobs[1].generation, 2);
    assert.equal(jobs[1].state, "QUEUED");
  });
});
