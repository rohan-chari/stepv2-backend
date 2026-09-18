const assert = require("node:assert/strict");
const test = require("node:test");

const { buildRecomputePlacements } = require("../../src/modules/races/jobs/placementRecompute");

const NOW = new Date("2026-07-19T12:00:00Z");
const HOUR = 60 * 60 * 1000;

// A timed race ending in ~1.9h whose total duration is well over 2h.
function timedRace(overrides = {}) {
  return {
    id: "race-1",
    name: "Big Walk",
    startedAt: new Date(NOW.getTime() - 5 * HOUR),
    endsAt: new Date(NOW.getTime() + 1.9 * HOUR),
    isTeamRace: false,
    potCoins: 0,
    ...overrides,
  };
}

function participant(id, overrides = {}) {
  return {
    id,
    userId: `user-${id}`,
    totalSteps: 100,
    finishedAt: null,
    forfeitedAt: null,
    // Set a baseline so the placement loop doesn't churn on it.
    lastNotifiedPlacement: 1,
    placementAlertsMuted: false,
    ...overrides,
  };
}

// Deps for buildRecomputePlacements. The eventBus captures RACE_ENDING_SOON and —
// like the real notification handler — records the durable audit row, so repeated
// ticks dedup through notificationModel.findFirstByUserTypeRace.
function makeDeps({ races, participants, disabled = false } = {}) {
  const state = { ending: [], audit: new Set() };
  const key = (u, t, r) => `${u}|${t}|${r}`;
  const deps = {
    now: () => NOW,
    isRaceEndingReminderDisabled: () => disabled,
    Race: {
      async findActiveInProgress() {
        return races;
      },
    },
    RaceParticipant: {
      async findAcceptedByRace() {
        return participants;
      },
      async update() {},
    },
    resolveRaceState: async () => {},
    requestStepSyncForUsers: async () => {},
    Notification: {
      async findFirstByUserTypeRace(userId, type, raceId) {
        return state.audit.has(key(userId, type, raceId)) ? { id: "x" } : null;
      },
    },
    eventBus: {
      emit(name, payload) {
        if (name !== "RACE_ENDING_SOON") return;
        state.ending.push(payload);
        // Emulate the handler's durable audit-row write.
        state.audit.add(key(payload.userId, "RACE_ENDING_SOON", payload.raceId));
      },
    },
    logger: { log() {}, error() {}, warn() {} },
  };
  return { deps, state };
}

test("fires once per accepted, active participant when a timed race is ~2h out", async () => {
  const { deps, state } = makeDeps({
    races: [timedRace()],
    participants: [participant("a"), participant("b")],
  });
  await buildRecomputePlacements(deps)();
  assert.equal(state.ending.length, 2);
  assert.deepEqual(new Set(state.ending.map((e) => e.userId)), new Set(["user-a", "user-b"]));
  assert.equal(state.ending[0].raceId, "race-1");
});

test("does NOT fire for an open-ended (endsAt null) step-target race", async () => {
  const { deps, state } = makeDeps({
    races: [timedRace({ endsAt: null })],
    participants: [participant("a")],
  });
  await buildRecomputePlacements(deps)();
  assert.equal(state.ending.length, 0);
});

test("does NOT fire for a short race whose total duration is <= 2h", async () => {
  // Started 30 min ago, ends in 1h -> total duration 1.5h < 2h.
  const short = timedRace({
    startedAt: new Date(NOW.getTime() - 0.5 * HOUR),
    endsAt: new Date(NOW.getTime() + 1 * HOUR),
  });
  const { deps, state } = makeDeps({ races: [short], participants: [participant("a")] });
  await buildRecomputePlacements(deps)();
  assert.equal(state.ending.length, 0);
});

test("does NOT fire before the 2h window (msLeft > 2h)", async () => {
  const notYet = timedRace({ endsAt: new Date(NOW.getTime() + 3 * HOUR) });
  const { deps, state } = makeDeps({ races: [notYet], participants: [participant("a")] });
  await buildRecomputePlacements(deps)();
  assert.equal(state.ending.length, 0);
});

test("excludes finished and forfeited participants", async () => {
  const { deps, state } = makeDeps({
    races: [timedRace()],
    participants: [
      participant("a"),
      participant("b", { finishedAt: new Date() }),
      participant("c", { forfeitedAt: new Date() }),
    ],
  });
  await buildRecomputePlacements(deps)();
  assert.deepEqual(state.ending.map((e) => e.userId), ["user-a"]);
});

test("fires exactly once per participant across repeated ticks (durable audit-row dedup)", async () => {
  const { deps, state } = makeDeps({
    races: [timedRace()],
    participants: [participant("a")],
  });
  const run = buildRecomputePlacements(deps);
  await run();
  await run(); // second tick — audit row now exists
  assert.equal(state.ending.length, 1);
});

test("the kill switch suppresses the reminder", async () => {
  const { deps, state } = makeDeps({
    races: [timedRace()],
    participants: [participant("a")],
    disabled: true,
  });
  await buildRecomputePlacements(deps)();
  assert.equal(state.ending.length, 0);
});

test("also fires for a timed TEAM race", async () => {
  const { deps, state } = makeDeps({
    races: [timedRace({ isTeamRace: true, teamSize: 2, teamAName: "A", teamBName: "B" })],
    participants: [
      participant("a", { team: "TEAM_A", lastNotifiedPlacement: null }),
      participant("b", { team: "TEAM_B", lastNotifiedPlacement: null }),
    ],
  });
  await buildRecomputePlacements(deps)();
  assert.equal(state.ending.length, 2);
});
