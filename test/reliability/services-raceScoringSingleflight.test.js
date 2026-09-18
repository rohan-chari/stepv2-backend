// Pending-load ownership, failure barriers and capacity are process-local
// scheduler properties that cannot be deterministically forced by HTTP timing.
// Real worker/HTTP outcomes are covered by the companion integration suite.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createScoringInputCache, prefetchRaceScoringModels } = require("../../src/modules/races/services/raceScoringPrefetch");
const start = new Date("2026-09-09T00:00:00Z");
const end = new Date("2026-09-09T01:00:00Z");
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture({ empty = false, cache = createScoringInputCache(), fail = false, maxRows = 100 } = {}) {
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  let reads = 0;
  const options = {
    races: [{ id: "race", startedAt: start, powerupsEnabled: false,
      participants: [{ id: "member", userId: "user" }] }], now: end,
    scoringInputCache: cache, sourceReadsOutsideTransaction: true,
    scoringInputVersionModel: { async findMany() { return [{ userId: "user", generation: 1n }]; } },
    stepsModel: { async findByUserIdsAndDateRange() { return []; } },
    stepSampleModel: { async findRowsForUserRanges(bounds, { cursor }) {
      reads++;
      await barrier;
      if (fail) throw new Error("source unavailable");
      return empty || cursor ? [] : [{ userId: "user", start, end, steps: 321, id: "sample", ordinal: bounds[0].ordinal }];
    } },
    raceActiveEffectModel: { async findEffectsForRaceParticipantsByTypes() { return {}; } },
    maxSampleRowsPerChunk: maxRows,
  };
  return { options, release, reads: () => reads };
}
for (const empty of [false, true]) test(`three concurrent compatible ${empty ? "empty" : "nonempty"} loads share one SELECT`, async () => {
  const f = fixture({ empty });
  const pending = [0, 1, 2].map(() => prefetchRaceScoringModels(f.options));
  await tick();
  assert.equal(f.reads(), 1);
  f.release();
  const results = await Promise.all(pending);
  assert.deepEqual(await Promise.all(results.map(r => r.stepSampleModel.sumStepsInWindow("user", start, end))), [empty ? 0 : 321, empty ? 0 : 321, empty ? 0 : 321]);
  results[0].stepSampleModel.releaseAll();
  assert.equal(await results[1].stepSampleModel.sumStepsInWindow("user", start, end), empty ? 0 : 321);
});
for (const kind of ["generation", "range", "model", "budget", "transaction"]) test(`${kind} mismatch never joins a pending or completed load`, async () => {
  const f = fixture();
  const other = { ...f.options };
  if (kind === "generation") other.scoringInputVersionModel = { async findMany() { return [{ userId: "user", generation: 2n }]; } };
  if (kind === "range") other.now = new Date("2026-09-10T01:00:00Z");
  if (kind === "model") other.stepSampleModel = { ...f.options.stepSampleModel };
  if (kind === "budget") other.maxRetainedSampleRowsPerUser = 10;
  if (kind === "transaction") other.sourceReadsOutsideTransaction = false;
  const pending = [prefetchRaceScoringModels(f.options), prefetchRaceScoringModels(other)];
  await tick();
  assert.equal(f.reads(), 2);
  f.release();
  const results = await Promise.all(pending);
  results.forEach(r => r.stepSampleModel.releaseAll());
  // A separately backed model cannot take a completed result from its peer.
  if (kind === "model") {
    await prefetchRaceScoringModels({ ...f.options, stepSampleModel: { ...f.options.stepSampleModel } });
    assert.equal(f.reads(), 3);
  }
});
test("rejected leader propagates once, clears pending state and permits subsequent retry", async () => {
  const cache = createScoringInputCache();
  const f = fixture({ cache, fail: true });
  const pending = [0,1,2].map(() => prefetchRaceScoringModels(f.options));
  const settled = Promise.allSettled(pending);
  await tick(); f.release();
  const results = await settled;
  assert.equal(f.reads(), 1);
  assert.ok(results.every(r => r.status === "rejected" && /source unavailable/.test(r.reason.message)));
  // Same datasource identity, now succeeding.
  f.options.stepSampleModel.findRowsForUserRanges = async () => [];
  assert.ok(await prefetchRaceScoringModels(f.options));
});
test("pending capacity overflow follows independent bounded loads", async () => {
  const f = fixture({ cache: createScoringInputCache({ maxUsers: 0 }) });
  const pending = [0,1,2].map(() => prefetchRaceScoringModels(f.options));
  await tick(); assert.equal(f.reads(), 3); f.release();
  (await Promise.all(pending)).forEach(r => r.stepSampleModel.releaseAll());
});
test("paged leader retains its spool and waiters reload with independent ownership", async () => {
  const f = fixture({ maxRows: 1 });
  f.options.maxRetainedSampleRowsPerUser = 1;
  const load = f.options.stepSampleModel.findRowsForUserRanges;
  f.options.stepSampleModel.findRowsForUserRanges = async (bounds, options) => {
    const rows = await load(bounds, options);
    if (options.cursor?.id === "sample") return [{ userId: "user", start, end, steps: 0, id: "last", ordinal: 0 }];
    return rows;
  };
  const pending = [0,1,2].map(() => prefetchRaceScoringModels(f.options));
  await tick(); assert.equal(f.reads(), 1); f.release();
  const results = await Promise.all(pending);
  assert.equal(f.reads(), 9, "each owner consumes its own three-page cursor");
  assert.equal(await results[0].stepSampleModel.sumStepsInWindow("user", start, end), 321);
  results[0].stepSampleModel.releaseAll();
  assert.equal(await results[1].stepSampleModel.sumStepsInWindow("user", start, end), 321);
  results.slice(1).forEach(r => r.stepSampleModel.releaseAll());
});
test("releasing a joined caller does not dispose another caller's in-flight source", async () => {
  const f = fixture();
  const options = { ...f.options, deferredSampleLoading: true };
  const [leader, waiter] = await Promise.all([prefetchRaceScoringModels(options), prefetchRaceScoringModels(options)]);
  const a = leader.stepSampleModel.prepareUsers(["user"]);
  const b = waiter.stepSampleModel.prepareUsers(["user"]);
  await tick();
  waiter.stepSampleModel.releaseAll();
  f.release();
  await Promise.all([a, b]);
  assert.equal(f.reads(), 1);
  assert.equal(await leader.stepSampleModel.sumStepsInWindow("user", start, end), 321);
  leader.stepSampleModel.releaseAll();
  waiter.stepSampleModel.releaseAll();
});
test("parallel input failure waits for source ownership and removes any late-created spool", async () => {
  const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
  const f = fixture({ maxRows: 1 });
  const directories = [];
  f.options.maxRetainedSampleRowsPerUser = 1;
  const load = f.options.stepSampleModel.findRowsForUserRanges;
  f.options.stepSampleModel.findRowsForUserRanges = async (bounds, options) => {
    const rows = await load(bounds, options);
    return options.cursor?.id === "sample"
      ? [{ userId: "user", start, end, steps: 0, id: "last", ordinal: 0 }]
      : rows;
  };
  f.options.createScoringScratchDirectory = () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bara-singleflight-test-"));
    directories.push(directory);
    return directory;
  };
  f.options.races[0].powerupsEnabled = true;
  f.options.raceActiveEffectModel.findEffectsForRaceParticipantsByTypes = async () => { throw new Error("effect read failed"); };
  const result = prefetchRaceScoringModels(f.options);
  const rejected = assert.rejects(result, /effect read failed/);
  await tick(); f.release(); await rejected;
  assert.equal(directories.length, 1);
  assert.ok(directories.every(directory => !fs.existsSync(directory)));
});
