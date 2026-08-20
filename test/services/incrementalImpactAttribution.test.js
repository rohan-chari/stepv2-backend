const assert = require("node:assert/strict");
const test = require("node:test");

const {
  computeEffectModifiers,
  createIncrementalEffectScoreCapture,
} = require("../../src/modules/races/services/effectiveStepScoring");
const {
  applyLeechTransfers,
  createIncrementalLeechTransferState,
} = require("../../src/modules/powerups/leechTransfers");
const {
  computeHitchhikeCopiedSteps,
  createIncrementalHitchhikeCopyCapture,
} = require("../../src/modules/powerups/hitchhikeCopies");

const START = new Date("2026-08-19T10:00:00.000Z");
const NOW = new Date("2026-08-19T11:30:00.000Z");

function at(minutes) {
  return new Date(START.getTime() + minutes * 60_000);
}

function effect(id, type, startMinute, endMinute, metadata = {}) {
  return {
    id,
    type,
    startsAt: at(startMinute),
    expiresAt: at(endMinute),
    status: "EXPIRED",
    metadata,
  };
}

function deterministicSampleModel(counter = null) {
  const sum = (_userId, start, end) => {
    // 0.4 steps/minute deliberately produces fractional multiplier terms.
    return ((new Date(end).getTime() - new Date(start).getTime()) / 60_000) * 0.4;
  };
  return {
    async sumClosedStepsInWindows(userId, windows) {
      if (counter) counter.batchReads += 1;
      return windows.map((window) => sum(userId, window.start, window.end));
    },
    async sumClosedStepsInWindow(userId, start, end) {
      return sum(userId, start, end);
    },
    async sumStepsInWindow(userId, start, end) {
      return sum(userId, start, end);
    },
  };
}

test("incremental sampled scorer matches every canonical nonlinear prefix with one context read", async () => {
  const effects = [
    effect("01-rh", "RUNNERS_HIGH", 0, 70),
    effect("02-rally", "RALLY_FLAG", 5, 65, { multiplier: 1.25 }),
    effect("03-rain", "RAINSTORM", 10, 60, { multiplier: 0.5 }),
    effect("04-umbrella", "UMBRELLA", 15, 25),
    effect("05-wrong", "WRONG_TURN", 20, 55),
    effect("06-freeze", "LEG_CRAMP", 30, 40),
    effect("07-pepper", "GHOST_PEPPER", 45, 75, {
      boostMs: 10 * 60_000,
      multiplier: 3,
    }),
    effect("08-coin", "COIN_FLIP", 50, 80, { multiplier: 0.25 }),
  ];
  const counter = { batchReads: 0 };
  const globalEvents = [{
    id: "global",
    startsAt: at(12),
    endsAt: at(58),
    multiplier: 2,
  }];
  const capture = await createIncrementalEffectScoreCapture({
    effects,
    rawTotal: 137,
    bonusSteps: 3,
    userId: "user",
    stepSampleModel: deterministicSampleModel(counter),
    hasSampleData: true,
    now: NOW,
    globalEvents,
  });

  const included = [];
  for (const row of effects) {
    included.push(row);
    capture.applyEffect(row);
    const modifiers = await computeEffectModifiers(
      included,
      137,
      "user",
      deterministicSampleModel(),
      true,
      { globalEvents, now: NOW },
      NOW,
    );
    const canonical = Math.max(
      0,
      140 - modifiers.frozenSteps + modifiers.buffedSteps -
        2 * modifiers.reversedSteps + (modifiers.globalBoostedSteps || 0),
    );
    assert.ok(
      Math.abs(capture.getFlooredTotal() - canonical) <=
        Number.EPSILON * Math.max(1, Math.abs(canonical)),
      row.id,
    );
  }
  assert.equal(counter.batchReads, 1);
});

test("incremental snapshot scorer preserves canonical overlap merge and participant floor", async () => {
  const effects = [
    effect("01-rh", "RUNNERS_HIGH", 0, 30, {
      stepsAtBuffStart: 100,
      stepsAtExpiry: 110,
    }),
    effect("02-rain-a", "RAINSTORM", 5, 25, {
      stepsAtStart: 100,
      stepsAtExpiry: 135,
      multiplier: 0.5,
    }),
    effect("03-rain-b", "RAINSTORM", 10, 30, {
      stepsAtStart: 105,
      stepsAtExpiry: 140,
      multiplier: 0.5,
    }),
    effect("04-freeze", "LEG_CRAMP", 20, 40, {
      stepsAtFreezeStart: 0,
      stepsAtExpiry: 500,
    }),
  ];
  const model = deterministicSampleModel();
  const capture = await createIncrementalEffectScoreCapture({
    effects,
    rawTotal: 140,
    bonusSteps: 0,
    userId: "user",
    stepSampleModel: model,
    hasSampleData: false,
    now: NOW,
  });
  const included = [];
  for (const row of effects) {
    included.push(row);
    capture.applyEffect(row);
    const modifiers = await computeEffectModifiers(
      included,
      140,
      "user",
      model,
      false,
      null,
      NOW,
    );
    assert.equal(
      capture.getFlooredTotal(),
      Math.max(0, 140 - modifiers.frozenSteps + modifiers.buffedSteps -
        2 * modifiers.reversedSteps),
      row.id,
    );
  }
  assert.equal(capture.getFlooredTotal(), 0);
});

test("incremental leech state matches canonical ordering when later score changes cross floors", () => {
  const entries = [
    { participantId: "victim", userId: "victim-user", preLeechTotal: 3 },
    { participantId: "a", userId: "attacker-a", preLeechTotal: 20 },
    { participantId: "b", userId: "attacker-b", preLeechTotal: 20 },
  ];
  const first = {
    effectId: "leech-a",
    startsAt: at(0),
    sourceUserId: "attacker-a",
    victimParticipantId: "victim",
    earnedTransfer: 5,
  };
  const second = {
    effectId: "leech-b",
    startsAt: at(1),
    sourceUserId: "attacker-b",
    victimParticipantId: "victim",
    earnedTransfer: 5,
  };
  const state = createIncrementalLeechTransferState(entries);
  const transfers = [];
  const assertParity = () => {
    const canonicalEntries = entries.map((entry) => ({
      ...entry,
      preLeechTotal: state.getPreLeechTotal(entry.participantId),
      leechTransfers: transfers
        .filter((row) => row.victimParticipantId === entry.participantId)
        .map(({ victimParticipantId: _ignored, ...row }) => row),
    }));
    assert.deepEqual(
      [...state.getFinalTotals().entries()],
      [...applyLeechTransfers(canonicalEntries).entries()],
    );
  };

  state.addTransfer(first);
  transfers.push(first);
  assertParity();
  state.addTransfer(second);
  transfers.push(second);
  assertParity();
  state.setPreLeechTotal("victim", 8);
  assertParity();
  state.setPreLeechTotal("victim", 1);
  assertParity();
});

test("incremental Hitchhike artifact tracks later target modifiers exactly", async () => {
  const hitchhike = {
    id: "hitch",
    type: "HITCHHIKE",
    startsAt: at(0),
    expiresAt: at(60),
    sourceUserId: "caster",
    targetUserId: "target",
    targetParticipantId: "target-participant",
    metadata: { scoringVersion: 2, copyRatio: 1 },
  };
  const targetEffects = [
    effect("01-rh", "RUNNERS_HIGH", 0, 60),
    effect("02-rain", "RAINSTORM", 5, 55, { multiplier: 0.5 }),
    effect("03-wrong", "WRONG_TURN", 10, 45),
    effect("04-freeze", "LEG_CRAMP", 20, 30),
  ];
  const samples = deterministicSampleModel();
  const capture = await createIncrementalHitchhikeCopyCapture({
    effect: hitchhike,
    targetEffects,
    stepSampleModel: samples,
    now: NOW,
    raceEndsAt: NOW,
    targetParticipantId: "target-participant",
    raceId: "race",
  });
  const included = [];
  for (const row of targetEffects) {
    included.push(row);
    capture.applyEffect(row);
    const canonical = await computeHitchhikeCopiedSteps(
      hitchhike,
      samples,
      NOW,
      {
        raceEndsAt: NOW,
        targetParticipantId: "target-participant",
        raceId: "race",
        raceActiveEffectModel: {
          async findEffectsForRaceByTypes() {
            return {
              LEG_CRAMP: included.filter((item) => item.type === "LEG_CRAMP"),
              QUICKSAND: [],
              RUNNERS_HIGH: included.filter((item) => item.type === "RUNNERS_HIGH"),
              WRONG_TURN: included.filter((item) => item.type === "WRONG_TURN"),
              CAMPFIRE_REST: [],
              RAINSTORM: included.filter((item) => item.type === "RAINSTORM"),
            };
          },
        },
      },
    );
    assert.equal(capture.getCopiedSteps(), canonical, row.id);
  }
});
