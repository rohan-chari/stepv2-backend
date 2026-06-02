const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildStartRace,
  RaceStartError,
} = require("../../src/commands/startRace");

// ---------------------------------------------------------------------------
// 1.1.7 — scheduled race start. Manual start (POST /races/:raceId/start) must
// be REJECTED while a race has a FUTURE scheduledStartAt, and ALLOWED once the
// scheduled time has passed or when scheduledStartAt is null (today's behavior).
//
// The auto-start cron job bypasses this guard (it starts AT/after the schedule)
// by passing bypassSchedule: true together with a `now` at the scheduled moment.
//
// DI mocks (no DB), mirroring test/commands/startRace.test.js.
// ---------------------------------------------------------------------------

function makeDeps({ scheduledStartAt = null, startedAt } = {}, overrides = {}) {
  const raceUpdates = [];
  const participantUpdates = [];
  const events = [];
  const fixedNow = startedAt || new Date("2026-06-02T14:00:00.000Z");

  return {
    raceUpdates,
    participantUpdates,
    events,
    fixedNow,
    deps: {
      Race: {
        async findById(id) {
          return {
            id,
            creatorId: "creator-1",
            status: "PENDING",
            maxDurationDays: 7,
            buyInAmount: 0,
            payoutPreset: "WINNER_TAKES_ALL",
            scheduledStartAt,
          };
        },
        async update(id, fields) {
          raceUpdates.push({ id, fields });
          return { id, ...fields };
        },
        ...overrides.Race,
      },
      RaceParticipant: {
        async countAccepted() {
          return 2;
        },
        async findAcceptedByRace() {
          return [
            { id: "rp-1", userId: "creator-1" },
            { id: "rp-2", userId: "friend-1" },
          ];
        },
        async update(id, fields) {
          participantUpdates.push({ id, fields });
          return { id, ...fields };
        },
        ...overrides.RaceParticipant,
      },
      Steps: {
        async findByUserIdAndDate() {
          return { steps: 0 };
        },
      },
      RacePowerupEvent: {
        async create() {
          return {};
        },
      },
      eventBus: {
        emit(event, payload) {
          events.push({ event, payload });
        },
      },
      now: () => fixedNow,
    },
  };
}

const HOUR = 60 * 60 * 1000;

test("manual start is ALLOWED when scheduledStartAt is null (existing behavior)", async () => {
  const { deps, raceUpdates } = makeDeps({ scheduledStartAt: null });
  const startRace = buildStartRace(deps);

  const result = await startRace({ userId: "creator-1", raceId: "race-1" });

  assert.ok(result);
  assert.ok(raceUpdates.some((u) => u.fields.status === "ACTIVE"));
});

test("manual start is REJECTED when scheduledStartAt is in the future", async () => {
  const now = new Date("2026-06-02T14:00:00.000Z");
  const future = new Date(now.getTime() + 2 * HOUR);
  const { deps, raceUpdates } = makeDeps({
    scheduledStartAt: future,
    startedAt: now,
  });
  const startRace = buildStartRace(deps);

  await assert.rejects(
    () => startRace({ userId: "creator-1", raceId: "race-1" }),
    (err) => {
      assert.ok(err instanceof RaceStartError);
      assert.equal(err.statusCode, 400);
      return true;
    }
  );
  assert.equal(
    raceUpdates.length,
    0,
    "race must not transition to ACTIVE when blocked"
  );
});

test("manual start is ALLOWED once scheduledStartAt has passed", async () => {
  const now = new Date("2026-06-02T14:00:00.000Z");
  const past = new Date(now.getTime() - 2 * HOUR);
  const { deps, raceUpdates } = makeDeps({
    scheduledStartAt: past,
    startedAt: now,
  });
  const startRace = buildStartRace(deps);

  const result = await startRace({ userId: "creator-1", raceId: "race-1" });

  assert.ok(result);
  assert.ok(raceUpdates.some((u) => u.fields.status === "ACTIVE"));
});

test("auto-start bypass starts a future-scheduled race and anchors endsAt to the scheduled moment", async () => {
  // The job calls startRace with bypassSchedule: true and now() pinned to the
  // scheduled start time, so the guard is skipped and endsAt = scheduledStart +
  // maxDurationDays.
  const scheduled = new Date("2026-06-05T09:00:00.000Z");
  const { deps, raceUpdates } = makeDeps({
    scheduledStartAt: scheduled,
    startedAt: scheduled, // now() pinned to schedule
  });
  const startRace = buildStartRace(deps);

  await startRace({
    userId: "creator-1",
    raceId: "race-1",
    bypassSchedule: true,
  });

  const statusUpdate = raceUpdates.find((u) => u.fields.status === "ACTIVE");
  assert.ok(statusUpdate, "race transitions to ACTIVE");
  const expectedEndsAt = new Date(scheduled.getTime() + 7 * 24 * HOUR);
  assert.equal(
    statusUpdate.fields.startedAt.toISOString(),
    scheduled.toISOString()
  );
  assert.equal(
    statusUpdate.fields.endsAt.toISOString(),
    expectedEndsAt.toISOString()
  );
});
