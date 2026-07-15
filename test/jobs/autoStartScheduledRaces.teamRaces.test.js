const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildAutoStartScheduledRaces,
} = require("../../src/jobs/autoStartScheduledRaces");

// TR-304: when a scheduled team race is due but teams are uneven, the tick
// SKIPS it (stays PENDING), notifies the creator once (first failed attempt
// only), and retries next tick.
function unevenError() {
  const err = new Error("Teams must be even to start — currently 2v1");
  err.name = "RaceStartError";
  err.statusCode = 409;
  err.code = "TEAMS_UNEVEN";
  return err;
}

function makeDeps({ notifiedBefore = false } = {}) {
  const state = { events: [], startAttempts: 0, notificationLookups: [] };
  const race = {
    id: "race-1",
    creatorId: "creator",
    seedId: null,
    status: "PENDING",
    scheduledStartAt: new Date(Date.now() - 60_000).toISOString(),
  };
  return {
    state,
    race,
    deps: {
      Race: {
        async findScheduledDue() {
          return [race];
        },
      },
      startRace: async () => {
        state.startAttempts += 1;
        throw unevenError();
      },
      eventBus: {
        emit(event, payload) {
          state.events.push({ event, payload });
        },
      },
      Notification: {
        async findFirstByUserTypeRace(userId, type, raceId) {
          state.notificationLookups.push({ userId, type, raceId });
          return notifiedBefore ? { id: "n-1" } : null;
        },
      },
      logger: { log() {}, error() {} },
    },
  };
}

test("TR-304 uneven scheduled team race is skipped and creator is notified on first failure", async () => {
  const ctx = makeDeps({ notifiedBefore: false });
  const job = buildAutoStartScheduledRaces(ctx.deps);
  const started = await job();

  assert.deepEqual(started, []);
  assert.equal(ctx.state.startAttempts, 1);
  const emitted = ctx.state.events.filter(
    (e) => e.event === "RACE_SCHEDULED_TEAMS_UNEVEN"
  );
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].payload.raceId, "race-1");
  assert.equal(emitted[0].payload.creatorUserId, "creator");
});

test("TR-304 no second notification once one was already sent (retries silently)", async () => {
  const ctx = makeDeps({ notifiedBefore: true });
  const job = buildAutoStartScheduledRaces(ctx.deps);
  await job();

  assert.equal(ctx.state.startAttempts, 1, "still retries the start each tick");
  const emitted = ctx.state.events.filter(
    (e) => e.event === "RACE_SCHEDULED_TEAMS_UNEVEN"
  );
  assert.equal(emitted.length, 0);
});

test("TR-304 non-team start failures don't emit the uneven event", async () => {
  const ctx = makeDeps({ notifiedBefore: false });
  ctx.deps.startRace = async () => {
    const err = new Error("At least 2 accepted participants are required");
    err.name = "RaceStartError";
    err.statusCode = 400;
    throw err;
  };
  const job = buildAutoStartScheduledRaces(ctx.deps);
  await job();
  assert.equal(ctx.state.events.length, 0);
});
