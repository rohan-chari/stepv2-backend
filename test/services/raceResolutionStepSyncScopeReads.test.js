const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildRaceResolutionStepSyncScope,
} = require("../../src/modules/races/services/raceResolutionStepSyncScope");

// CPU regression suite for the step-sync scope's READ pattern.
//
// The scope is admissible only on a race with ZERO active effects, and ~79% of
// prod jobs have at least one. The old implementation issued the race read in
// parallel with the effects read and discarded it on every one of those jobs.
// These tests pin the new sequencing: effects FIRST, short-circuit, and only
// then a LEAN race read.

const startedAt = new Date("2026-08-13T12:00:05.000Z");

const job = {
  raceId: "r1",
  startedAt,
  processingDirtyReasons: ["STEP_SYNC"],
  processingDirtyParticipantIds: ["p1"],
  processingTriggeredByUserIds: ["u1"],
};

function raceRow() {
  return {
    id: "r1",
    status: "ACTIVE",
    powerupsEnabled: true,
    isTeamRace: false,
    participants: [
      {
        id: "p1",
        userId: "u1",
        status: "ACCEPTED",
        totalSteps: 50,
        rawSteps: 45,
        bonusSteps: 5,
        maxBonusSteps: 5,
        totalsUpdatedAt: new Date("2026-08-13T12:00:04.000Z"),
      },
    ],
  };
}

// A spy race model that records EVERY method call, so an accidental
// reintroduction of the fat `findById` is caught, not just a missing call.
function spyRaceModel(row = raceRow()) {
  const calls = [];
  return {
    calls,
    async findForStepSyncScope(id) {
      calls.push(["findForStepSyncScope", id]);
      return row;
    },
    async findById(id) {
      calls.push(["findById", id]);
      return row;
    },
  };
}

function effectModel(effects, calls = []) {
  return {
    calls,
    async findActiveForRace(id) {
      calls.push(["findActiveForRace", id]);
      return effects;
    },
  };
}

test("active effect => NO race read is issued at all (the 79% path)", async () => {
  const Race = spyRaceModel();
  const RaceActiveEffect = effectModel([{ type: "LEECH" }]);

  const scope = await buildRaceResolutionStepSyncScope(job, {
    Race,
    RaceActiveEffect,
  });

  assert.equal(scope, null);
  assert.deepEqual(
    Race.calls,
    [],
    "the race model must never be touched once an active effect is seen"
  );
  assert.deepEqual(RaceActiveEffect.calls, [["findActiveForRace", "r1"]]);
});

test("several active effects still short-circuit before any race read", async () => {
  const Race = spyRaceModel();
  const scope = await buildRaceResolutionStepSyncScope(job, {
    Race,
    RaceActiveEffect: effectModel([{ type: "LEECH" }, { type: "RAINSTORM" }]),
  });
  assert.equal(scope, null);
  assert.deepEqual(Race.calls, []);
});

test("a job rejected on ENVELOPE shape reads neither model", async () => {
  const Race = spyRaceModel();
  const RaceActiveEffect = effectModel([]);
  const scope = await buildRaceResolutionStepSyncScope(
    { ...job, processingDirtyReasons: ["STEP_SYNC", "BOX_OPEN"] },
    { Race, RaceActiveEffect }
  );
  assert.equal(scope, null);
  assert.deepEqual(Race.calls, []);
  assert.deepEqual(RaceActiveEffect.calls, []);
});

test("surviving path reads effects FIRST, then exactly one LEAN race read", async () => {
  const shared = [];
  const Race = spyRaceModel();
  Race.calls = shared;
  const RaceActiveEffect = effectModel([], shared);
  // Re-point the race spy at the shared ordering log.
  const orderedRace = {
    async findForStepSyncScope(id) {
      shared.push(["findForStepSyncScope", id]);
      return raceRow();
    },
    async findById(id) {
      shared.push(["findById", id]);
      return raceRow();
    },
  };

  const scope = await buildRaceResolutionStepSyncScope(job, {
    Race: orderedRace,
    RaceActiveEffect,
  });

  assert.ok(scope, "zero-effect job must still produce a scope");
  assert.deepEqual(shared, [
    ["findActiveForRace", "r1"],
    ["findForStepSyncScope", "r1"],
  ], "effects must be read first and the FAT findById must never be called");
});

test("surviving path produces a byte-identical scope to the pre-change shape", async () => {
  const scope = await buildRaceResolutionStepSyncScope(job, {
    Race: spyRaceModel(),
    RaceActiveEffect: effectModel([]),
  });

  // The exact object the old parallel/fat implementation returned for this
  // input. Anything that changes here changes the worker's plan payload.
  assert.deepEqual(
    JSON.parse(JSON.stringify({
      plan: scope.plan,
      participantTokens: scope.participantTokens,
      participantUserIds: scope.participantUserIds,
      result: {
        raceId: scope.result.raceId,
        baseAdjustedByParticipantId: scope.result.baseAdjustedByParticipantId,
        boxEffectiveStepsByUser: scope.result.boxEffectiveStepsByUser,
      },
    })),
    {
      plan: "STEP_SYNC_COMMITTED",
      participantTokens: { p1: "2026-08-13T12:00:04.000Z" },
      participantUserIds: { p1: "u1" },
      result: {
        raceId: "r1",
        baseAdjustedByParticipantId: { p1: 45 },
        boxEffectiveStepsByUser: { u1: 45 },
      },
    }
  );

  // `result.race` is the row the lean finder returned, unwrapped — downstream
  // consumers (retainTeamAsOfHeartbeat, the high-multiplier alert pass,
  // syncRacePowerupState) read it directly.
  assert.equal(scope.result.race.id, "r1");
  assert.equal(scope.result.race.isTeamRace, false);
  assert.equal(scope.result.race.powerupsEnabled, true);
  assert.equal(scope.result.race.participants.length, 1);
});

test("non-ACTIVE race still fails closed after the lean read", async () => {
  const row = raceRow();
  row.status = "COMPLETED";
  const scope = await buildRaceResolutionStepSyncScope(job, {
    Race: spyRaceModel(row),
    RaceActiveEffect: effectModel([]),
  });
  assert.equal(scope, null);
});

test("missing race row fails closed", async () => {
  const scope = await buildRaceResolutionStepSyncScope(job, {
    Race: {
      async findForStepSyncScope() {
        return null;
      },
    },
    RaceActiveEffect: effectModel([]),
  });
  assert.equal(scope, null);
});

test("a throwing race read fails closed rather than escaping", async () => {
  const scope = await buildRaceResolutionStepSyncScope(job, {
    Race: {
      async findForStepSyncScope() {
        throw new Error("db down");
      },
    },
    RaceActiveEffect: effectModel([]),
  });
  assert.equal(scope, null);
});

test("a throwing effects read fails closed and never reads the race", async () => {
  const Race = spyRaceModel();
  const scope = await buildRaceResolutionStepSyncScope(job, {
    Race,
    RaceActiveEffect: {
      async findActiveForRace() {
        throw new Error("db down");
      },
    },
  });
  assert.equal(scope, null);
  assert.deepEqual(Race.calls, []);
});

// ── The lean select must not starve a downstream consumer. ───────────────────
//
// This is a STRUCTURAL guard over the model's select, not a behavioral test:
// the fields below were derived by tracing every read of `result.race` on the
// STEP_SYNC_COMMITTED plan (queue worker -> raceProgressSideEffects ->
// highMultiplierAlert, and syncRacePowerupState). Dropping one of them from
// the select produces a silent null downstream, not a crash.
test("findForStepSyncScope selects every field a STEP_SYNC_COMMITTED consumer reads", async () => {
  const source = require("node:fs").readFileSync(
    require.resolve("../../src/modules/races/models/race.js"),
    "utf8"
  );
  const start = source.indexOf("const stepSyncScopeParticipantSelect");
  assert.ok(start > 0, "stepSyncScopeParticipantSelect must exist");
  const block = source.slice(start, source.indexOf("const Race = {", start));

  // `stepSyncScopeParticipantSelect` spreads `resolutionParticipantSelect`,
  // which in turn spreads `mysteryBoxParticipantSelect` — so assert on the
  // resolved object rather than the literal text.
  const { Race } = require("../../src/modules/races/models/race");
  assert.equal(typeof Race.findForStepSyncScope, "function");

  // The one column the resolution select does not already carry.
  assert.match(block, /totalsUpdatedAt:\s*true/);
  assert.match(block, /\.\.\.resolutionParticipantSelect/);
  assert.match(block, /\.\.\.resolutionRaceSelect/);
  // Participants stay UNFILTERED and joinedAt-ordered, matching the fat include.
  assert.match(block, /orderBy:\s*\{\s*joinedAt:\s*"asc"\s*\}/);
  assert.ok(
    !/where:/.test(block),
    "participants must not be filtered — the alert pass needs the full roster"
  );
  // The whole point: the accessory subtree is gone.
  assert.ok(!/equippedAccessories/.test(block));
  assert.ok(!/renderMetadata/.test(block));
});
