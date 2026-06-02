const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildAutoStartScheduledRaces,
  selectRacesToAutoStart,
} = require("../../src/jobs/autoStartScheduledRaces");

// ---------------------------------------------------------------------------
// 1.1.7 — auto-start scheduled races cron job. Runs on the same 5-minute cadence
// as the other jobs in src/index.js. The PURE selection (which PENDING races are
// due to start now, excluding seeded races) is `selectRacesToAutoStart`; the job
// reuses the EXISTING startRace logic to actually transition each one.
//
// DI mocks (no DB), mirroring test/jobs/seededRaceRenewal.test.js and
// test/jobs/globalStepEventScheduler.test.js.
// ---------------------------------------------------------------------------

const NOW = new Date("2026-06-02T14:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const past = (ms) => new Date(NOW.getTime() - ms);
const future = (ms) => new Date(NOW.getTime() + ms);

// --- pure selection -------------------------------------------------------

test("selection picks PENDING races whose scheduledStartAt <= now", async () => {
  const races = [
    { id: "due-1", status: "PENDING", scheduledStartAt: past(HOUR), seedId: null },
    { id: "due-2", status: "PENDING", scheduledStartAt: NOW, seedId: null },
  ];
  const picked = selectRacesToAutoStart({ races, now: NOW });
  assert.deepEqual(
    picked.map((r) => r.id).sort(),
    ["due-1", "due-2"]
  );
});

test("selection excludes races whose scheduledStartAt is in the future", async () => {
  const races = [
    { id: "later", status: "PENDING", scheduledStartAt: future(HOUR), seedId: null },
  ];
  const picked = selectRacesToAutoStart({ races, now: NOW });
  assert.equal(picked.length, 0);
});

test("selection excludes races with no scheduledStartAt (manual races)", async () => {
  const races = [
    { id: "manual", status: "PENDING", scheduledStartAt: null, seedId: null },
  ];
  const picked = selectRacesToAutoStart({ races, now: NOW });
  assert.equal(picked.length, 0);
});

test("selection excludes already-active races (idempotent — not re-started)", async () => {
  const races = [
    { id: "active", status: "ACTIVE", scheduledStartAt: past(HOUR), seedId: null },
  ];
  const picked = selectRacesToAutoStart({ races, now: NOW });
  assert.equal(picked.length, 0);
});

test("selection excludes seeded races (handled by seededRaceRenewal)", async () => {
  const races = [
    { id: "seeded", status: "PENDING", scheduledStartAt: past(HOUR), seedId: "seed-1" },
    { id: "user", status: "PENDING", scheduledStartAt: past(HOUR), seedId: null },
  ];
  const picked = selectRacesToAutoStart({ races, now: NOW });
  assert.deepEqual(
    picked.map((r) => r.id),
    ["user"]
  );
});

// --- job wiring -----------------------------------------------------------

function makeCtx({ dueRaces = [], startThrows = {} } = {}) {
  const startCalls = [];
  return {
    startCalls,
    deps: {
      Race: {
        async findScheduledDue(now) {
          // Model returns only PENDING, non-seeded, due races. The job still
          // runs them through selectRacesToAutoStart for defense-in-depth.
          return dueRaces.filter(
            (r) =>
              r.status === "PENDING" &&
              !r.seedId &&
              r.scheduledStartAt &&
              new Date(r.scheduledStartAt).getTime() <= now.getTime()
          );
        },
      },
      startRace: async (args) => {
        startCalls.push(args);
        if (startThrows[args.raceId]) {
          throw new Error(startThrows[args.raceId]);
        }
        return { id: args.raceId, status: "ACTIVE" };
      },
      now: () => NOW,
      logger: { log() {}, error() {} },
    },
  };
}

test("job starts each due race via startRace, bypassing the schedule guard at the scheduled moment", async () => {
  const scheduled = past(HOUR);
  const ctx = makeCtx({
    dueRaces: [
      {
        id: "race-1",
        status: "PENDING",
        scheduledStartAt: scheduled,
        seedId: null,
        creatorId: "creator-1",
      },
    ],
  });

  const run = buildAutoStartScheduledRaces(ctx.deps);
  await run();

  assert.equal(ctx.startCalls.length, 1);
  const call = ctx.startCalls[0];
  assert.equal(call.raceId, "race-1");
  assert.equal(call.userId, "creator-1");
  assert.equal(call.bypassSchedule, true);
  // endsAt must anchor to the scheduled start moment, so the job pins now() to
  // scheduledStartAt for that start.
  assert.equal(
    new Date(call.now()).toISOString(),
    new Date(scheduled).toISOString()
  );
});

test("job does nothing when there are no due races", async () => {
  const ctx = makeCtx({ dueRaces: [] });
  const run = buildAutoStartScheduledRaces(ctx.deps);
  await run();
  assert.equal(ctx.startCalls.length, 0);
});

test("job does not start seeded races even if the model leaks one", async () => {
  // Defense-in-depth: selectRacesToAutoStart drops seeded races.
  const ctx = makeCtx({ dueRaces: [] });
  // Override findScheduledDue to leak a seeded race.
  ctx.deps.Race.findScheduledDue = async () => [
    {
      id: "seeded",
      status: "PENDING",
      scheduledStartAt: past(HOUR),
      seedId: "seed-1",
      creatorId: null,
    },
  ];
  const run = buildAutoStartScheduledRaces(ctx.deps);
  await run();
  assert.equal(ctx.startCalls.length, 0);
});

test("job continues starting remaining races when one start fails", async () => {
  const ctx = makeCtx({
    dueRaces: [
      {
        id: "race-bad",
        status: "PENDING",
        scheduledStartAt: past(HOUR),
        seedId: null,
        creatorId: "creator-1",
      },
      {
        id: "race-good",
        status: "PENDING",
        scheduledStartAt: past(HOUR),
        seedId: null,
        creatorId: "creator-2",
      },
    ],
    startThrows: { "race-bad": "not enough participants" },
  });

  const run = buildAutoStartScheduledRaces(ctx.deps);
  await run();

  assert.equal(ctx.startCalls.length, 2);
  assert.ok(ctx.startCalls.some((c) => c.raceId === "race-good"));
});
