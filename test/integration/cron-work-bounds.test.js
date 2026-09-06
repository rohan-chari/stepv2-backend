const assert = require("node:assert/strict");
const { beforeEach, describe, it } = require("node:test");
const { Client } = require("pg");
const { cleanDatabase, createTestUser, prisma, getSharedServer, request } = require("./setup");
const { buildGlobalEventSummaryV2Tick } = require("../../src/modules/steps/jobs/globalEventSummary");
const { buildRenewSeededRaces } = require("../../src/modules/races/jobs/seededRaceRenewal");
const { appSettings } = require("../../src/shared/config/appSettings");
const { buildNotificationProjector } = require("../../src/modules/domainEvents/services/notificationProjector");

// These jobs have no HTTP endpoint. Enter at the production cron callback,
// observe real driver calls, and never replace SQL results with mocks.
function observeQueries(t) {
  const queries = [];
  const original = Client.prototype.query;
  t.mock.method(Client.prototype, "query", function (...args) {
    const text = typeof args[0] === "string" ? args[0] : args[0].text;
    queries.push(text);
    return original.apply(this, args);
  });
  return queries;
}
function observeSampleRows(t) {
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
const ageCleanup = (sql) => /DELETE FROM durable_capture_(method_progress|interval_projections|prepared_inputs)/i.test(sql);

describe("cron work bounds against real PostgreSQL", () => {
  beforeEach(cleanDatabase);

  it("routine capture wakes do not perform historical retention; recovery still does", async (t) => {
    const queries = observeQueries(t);
    const tick = buildGlobalEventSummaryV2Tick({ prisma, now: () => new Date() });
    await tick({ recovery: false });
    await tick({ recovery: false });
    assert.equal(queries.filter(ageCleanup).length, 0, "empty wakes must not repeatedly scan retained history");
    queries.length = 0;
    await tick({ recovery: true });
    assert.equal(queries.filter(ageCleanup).length, 3, "recovery must retain all three bounded collectors");
  });

  it("retention uses indexable fixed cutoffs rather than a per-row volatile clock", async (t) => {
    const queries = observeQueries(t);
    await buildGlobalEventSummaryV2Tick({ prisma, now: () => new Date() })({ recovery: true });
    const collected = queries.filter(ageCleanup);
    assert.equal(collected.length, 3);
    for (const sql of collected) {
      assert.doesNotMatch(sql, /clock_timestamp\(\)/, "retention range must be usable as an index condition");
    }
  });

  it("recovery collects old derived progress in bounded pages while preserving recent rows", async () => {
    const account = await createTestUser();
    await prisma.$executeRawUnsafe(`INSERT INTO durable_capture_method_progress
      (scope_digest,method_digest,user_id,state,updated_at)
      SELECT lpad(i::text,64,'0'),repeat('a',64),$1,'{}'::jsonb,
        CURRENT_TIMESTAMP-CASE WHEN i<=132 THEN interval '31 days' ELSE interval '1 day' END
      FROM generate_series(1,135) i`, account.user.id);
    const count = async () => Number((await prisma.$queryRawUnsafe(
      "SELECT count(*)::int AS n FROM durable_capture_method_progress WHERE user_id=$1", account.user.id))[0].n);
    const tick = buildGlobalEventSummaryV2Tick({ prisma, now: () => new Date() });
    await tick({ recovery: false });
    assert.equal(await count(), 135, "normal wake must leave historical collection to recovery");
    await tick({ recovery: true });
    assert.equal(await count(), 7, "exactly one bounded page of 128 old rows is collected");
    await tick({ recovery: false });
    assert.equal(await count(), 3, "a full retention page must continue on the next wake, without a minute-long backlog stall");
    await tick({ recovery: true });
    assert.equal(await count(), 3, "empty collector is idempotent");
  });

  it("routine wakes still compact eligible live mutation journals", async () => {
    const account = await createTestUser();
    await prisma.stepSample.create({ data: { userId: account.user.id,
      periodStart: new Date("2026-01-01T12:00:00Z"), periodEnd: new Date("2026-01-01T12:01:00Z"), steps: 1 } });
    await prisma.$executeRawUnsafe(`UPDATE durable_capture_fact_heads
      SET updated_at=CURRENT_TIMESTAMP-interval '11 minutes',next_compaction_at=CURRENT_TIMESTAMP-interval '1 second'
      WHERE user_id=$1`, account.user.id);
    const count = async () => Number((await prisma.$queryRawUnsafe(
      "SELECT count(*)::int AS n FROM durable_capture_fact_journal WHERE user_id=$1", account.user.id))[0].n);
    assert.ok(await count() > 0, "source writes must create a real mutation journal");
    await buildGlobalEventSummaryV2Tick({ prisma })({ recovery: false });
    assert.equal(await count(), 0, "live journal maintenance cannot wait for age-based retention");
  });

  it("an already elected bucket cohort performs no sample-history reads on retry", async (t) => {
    // Other integration suites retain custom active seeds. This regression is
    // specifically the production daily/weekly bucket retry, not legacy seeds.
    const otherSeeds = await prisma.raceSeed.findMany({ where: { active: true, kind: { notIn: ["DAILY_10K", "WEEKLY_50K"] } } });
    await prisma.raceSeed.updateMany({ where: { id: { in: otherSeeds.map(s => s.id) } }, data: { active: false } });
    t.after(() => prisma.raceSeed.updateMany({ where: { id: { in: otherSeeds.map(s => s.id) } }, data: { active: true } }));
    await appSettings.setFlag("seededRaceBucketsEnabled", true);
    await appSettings.setFlag("seededInactivityPruneEnabled", true);
    await createTestUser({ autoJoinFeaturedRaces: true, clientFeatures: ["seeded_race_buckets"] });
    const errors = [];
    const renew = buildRenewSeededRaces({ prisma, logger: { log() {}, error(...args) { errors.push(args); } } });
    await renew();
    assert.equal(errors.length, 0);
    const before = await prisma.seededRaceWindowMembership.findMany();
    assert.ok(before.length >= 2, "first cron tick must elect daily and weekly membership");
    const queries = observeQueries(t);
    await renew();
    assert.equal(errors.length, 0);
    assert.equal(queries.filter(sql => /SELECT/i.test(sql) && /step_samples/i.test(sql)).length, 0,
      "existing membership must be excluded before activity lookup: " + [...new Set(queries.filter(sql => /step_samples/.test(sql)))].join("\n"));
    assert.deepEqual(await prisma.seededRaceWindowMembership.findMany({ orderBy: { id: "asc" } }),
      [...before].sort((a,b) => a.id.localeCompare(b.id)));
  });

  it("first enrollment reads activity indicators, not every historical sample", async (t) => {
    await appSettings.setFlag("seededRaceBucketsEnabled", true);
    await appSettings.setFlag("seededInactivityPruneEnabled", true);
    const account = await createTestUser({ autoJoinFeaturedRaces: true, clientFeatures: ["seeded_race_buckets"],
      createdAt: new Date(Date.now() - 10 * 86400000) });
    const start = Date.now() - 36 * 3600000;
    await prisma.stepSample.createMany({ data: Array.from({ length: 1000 }, (_, i) => ({
      userId: account.user.id, periodStart: new Date(start + i * 1000), periodEnd: new Date(start + i * 1000 + 999), steps: 1,
    })) });
    const reads = observeSampleRows(t);
    const errors = [];
    await buildRenewSeededRaces({ prisma, logger: { log() {}, error(...args) { errors.push(args); } } })();
    assert.equal(errors.length, 0);
    assert.ok(reads.length > 0, "must observe real PostgreSQL activity queries");
    assert.ok(reads.every(read => read.rows <= 1), `one candidate must return at most one indicator, observed ${reads.map(r => r.rows)}`);
    assert.ok(await prisma.seededRaceWindowMembership.count({ where: { userId: account.user.id, stream: "BUCKET" } }) >= 2,
      "positive sample activity must preserve daily and weekly election");
  });

  for (const window of [
    { name: "spring DST", now: "2026-03-11T01:30:00Z", start: "2026-03-08T05:00:00Z", end: "2026-03-10T04:00:00Z", daily: "2026-03-07" },
    { name: "fall DST", now: "2026-11-03T17:00:00Z", start: "2026-11-01T04:00:00Z", end: "2026-11-03T05:00:00Z", daily: "2026-10-31" },
  ]) it(`real election preserves activity boundaries and exemptions across ${window.name}`, async (t) => {
    // Renewal's downstream legacy enrollment also uses the process clock.
    // Freeze Date for the whole callback chain, not just renewal's injected now.
    t.mock.timers.enable({ apis: ["Date"], now: new Date(window.now) });
    const others = await prisma.raceSeed.findMany({ where: { active: true, kind: { notIn: ["DAILY_10K", "WEEKLY_50K"] } } });
    await prisma.raceSeed.updateMany({ where: { id: { in: others.map(s => s.id) } }, data: { active: false } });
    t.after(() => prisma.raceSeed.updateMany({ where: { id: { in: others.map(s => s.id) } }, data: { active: true } }));
    await appSettings.setFlag("seededRaceBucketsEnabled", true);
    await appSettings.setFlag("seededInactivityPruneEnabled", true);
    const start = new Date(window.start).getTime();
    const end = new Date(window.end).getTime();
    const cases = [
      { name: "at lower boundary", sample: start, keep: true },
      { name: "before upper boundary", sample: end - 1, keep: true },
      { name: "at upper boundary", sample: end, keep: false },
      { name: "overlap from previous day", sample: start - 1, keep: false },
      { name: "zero", sample: start, steps: 0, keep: false },
      { name: "negative", sample: start, steps: -1, keep: false },
      { name: "daily lower boundary", daily: new Date(window.daily), keep: true },
      { name: "daily ahead timezone", daily: new Date(end + 86400000), keep: true },
      { name: "daily too old", daily: new Date(new Date(window.daily).getTime() - 86400000), keep: false },
      { name: "new", createdAt: new Date(start), keep: true },
      { name: "review", isReviewAccount: true, keep: true },
      { name: "missing activity", keep: false },
    ];
    for (const fixture of cases) {
      const account = await createTestUser({ autoJoinFeaturedRaces: true, clientFeatures: ["seeded_race_buckets"],
        createdAt: fixture.createdAt || new Date("2020-01-01"), isReviewAccount: fixture.isReviewAccount || false });
      fixture.userId = account.user.id;
      if (fixture.sample !== undefined) await prisma.stepSample.create({ data: { userId: fixture.userId,
        periodStart: new Date(fixture.sample), periodEnd: new Date(fixture.sample + 1000), steps: fixture.steps ?? 1 } });
      if (fixture.daily) await prisma.step.create({ data: { userId: fixture.userId, date: fixture.daily, steps: 1 } });
    }
    const errors = [];
    await buildRenewSeededRaces({ prisma, now: () => new Date(window.now),
      logger: { log() {}, error(...args) { errors.push(args); } } })();
    assert.equal(errors.length, 0, JSON.stringify(errors));
    for (const fixture of cases) {
      const count = await prisma.seededRaceWindowMembership.count({ where: { userId: fixture.userId, stream: "BUCKET" } });
      assert.equal(count, fixture.keep ? 2 : 0, fixture.name);
    }
  });

  it("notification fanout bounds concurrent queries to two and delivers every intent", async (t) => {
    await appSettings.setFlag("apiInboxV1Enabled", true);
    const server = await getSharedServer();
    const sender = await createTestUser();
    const recipients = [];
    for (let i = 0; i < 4; i++) {
      const account = await createTestUser();
      recipients.push(account.user.id);
      const response = await request(server.baseUrl, "POST", "/friends/request", {
        token: sender.token, body: { addresseeId: account.user.id },
      });
      assert.equal(response.status, 201);
    }
    let inFlight = 0;
    let peak = 0;
    const original = Client.prototype.query;
    t.mock.method(Client.prototype, "query", function (...args) {
      const result = original.apply(this, args);
      if (!result?.then) return result;
      inFlight++;
      peak = Math.max(peak, inFlight);
      return result.finally(() => { inFlight--; });
    });
    const projector = buildNotificationProjector({ prisma, logger: { log() {}, warn() {}, error() {} } });
    await projector.run();
    await projector.run();
    assert.ok(peak <= 2, `one projector must not occupy all four cron connections (observed ${peak})`);
    assert.equal(await prisma.inboxAlert.count({ where: { userId: { in: recipients }, type: "FRIEND_REQUEST_SENT" } }), 4);
    await projector.run();
    assert.equal(await prisma.inboxAlert.count({ where: { userId: { in: recipients }, type: "FRIEND_REQUEST_SENT" } }), 4,
      "retries must not duplicate delivery intents");
  });
});
