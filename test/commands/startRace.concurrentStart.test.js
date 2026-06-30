const assert = require("node:assert/strict");
const test = require("node:test");

const { buildStartRace } = require("../../src/commands/startRace");

// Fix 2: startRace must only emit RACE_STARTED when it actually flips the race
// PENDING -> ACTIVE. The status check at the top is a read (TOCTOU): two runners
// (manual Start racing the auto-start cron, or two server instances) can both
// read PENDING and both emit a duplicate "Race Started! Go!" push. The flip must
// be a conditional write; the loser (count === 0) must emit nothing.

function makeCtx({ flipCount = 1 } = {}) {
  const emits = [];
  const feedEvents = [];
  const participants = [
    { id: "p1", userId: "creator-1", buyInStatus: "NONE", buyInAmount: 0 },
    { id: "p2", userId: "u2", buyInStatus: "NONE", buyInAmount: 0 },
  ];

  const deps = {
    Race: {
      async findById() {
        return {
          id: "race-1",
          creatorId: "creator-1",
          status: "PENDING",
          scheduledStartAt: null,
          maxDurationDays: 7,
          powerupsEnabled: false,
          potCoins: 0,
          name: "Fam Steps",
        };
      },
      // Unconditional write (legacy path) — should NOT be used by the fixed code.
      async update(id, fields) {
        return { id, status: "ACTIVE", ...fields };
      },
      // Conditional flip — returns how many rows matched WHERE status = PENDING.
      async updateIfPending() {
        return { count: flipCount };
      },
    },
    RaceParticipant: {
      async countAccepted() {
        return participants.length;
      },
      async findAcceptedByRace() {
        return participants;
      },
      async update() {
        return {};
      },
    },
    Steps: {
      async findByUserIdAndDate() {
        return null;
      },
    },
    RacePowerupEvent: {
      // The RacePowerupEvent model wrapper takes fields directly.
      async create(data) {
        feedEvents.push(data);
        return { id: `fe-${feedEvents.length}`, ...data };
      },
    },
    eventBus: {
      emit(event, payload) {
        emits.push({ event, payload });
      },
    },
  };

  return { deps, emits, feedEvents };
}

test("emits exactly one RACE_STARTED when the flip wins (count === 1)", async () => {
  const ctx = makeCtx({ flipCount: 1 });
  const startRace = buildStartRace(ctx.deps);

  await startRace({ userId: "creator-1", raceId: "race-1" });

  const started = ctx.emits.filter((e) => e.event === "RACE_STARTED");
  assert.equal(started.length, 1);
  const startedFeed = ctx.feedEvents.filter((f) => f.eventType === "RACE_STARTED");
  assert.equal(startedFeed.length, 1);
});

test("emits NO RACE_STARTED when a concurrent runner already flipped it (count === 0)", async () => {
  const ctx = makeCtx({ flipCount: 0 });
  const startRace = buildStartRace(ctx.deps);

  // Must not throw and must not double-notify; it simply lost the race.
  await startRace({ userId: "creator-1", raceId: "race-1" });

  const started = ctx.emits.filter((e) => e.event === "RACE_STARTED");
  assert.equal(started.length, 0, "loser must not emit a duplicate Race Started");
  const startedFeed = ctx.feedEvents.filter((f) => f.eventType === "RACE_STARTED");
  assert.equal(startedFeed.length, 0, "loser must not write a duplicate feed event");
});
