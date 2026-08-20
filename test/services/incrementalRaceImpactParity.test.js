const assert = require("node:assert/strict");
const test = require("node:test");

const {
  calculateCurrentTotal,
  captureIncrementalRacePrefixTerms,
} = require("../../src/modules/races/services/raceStateResolution");
const {
  computeSettlementAttributionVector,
  computeSelectedPrefixAttributionVector,
} = require("../../src/modules/races/services/raceSettlementAttribution");
const {
  collectRaceHitchhikeCopies,
  applyHitchhikeCopies,
} = require("../../src/modules/powerups/hitchhikeCopies");
const { applyLeechTransfers } = require("../../src/modules/powerups/leechTransfers");
const {
  SETTLEMENT_EFFECT_TYPES,
} = require("../../src/modules/races/services/raceScoringEffectTypes");

const start = new Date("2026-08-19T10:00:00.000Z");
const now = new Date("2026-08-19T12:30:00.000Z");
const minute = (value) => new Date(start.getTime() + value * 60_000);

function row(id, type, target, offset, metadata = {}) {
  return {
    id,
    type,
    raceId: "race",
    targetParticipantId: target.id,
    targetUserId: target.userId,
    sourceUserId: target.userId,
    startsAt: minute(offset),
    expiresAt: minute(70),
    status: "EXPIRED",
    metadata,
  };
}

function samples() {
  const sum = (userId, from, to) => {
    const rate = userId === "u1" ? 0.43 : userId === "u2" ? 0.31 : 0.27;
    return Math.max(0, (new Date(to) - new Date(from)) / 60_000) * rate;
  };
  return {
    sumStepsInWindow: async (userId, from, to) => sum(userId, from, to),
    sumClosedStepsInWindow: async (userId, from, to) => sum(userId, from, to),
    sumStepsInWindows: async (userId, windows) =>
      windows.map((window) => sum(userId, window.start, window.end)),
    sumClosedStepsInWindows: async (userId, windows) =>
      windows.map((window) => sum(userId, window.start, window.end)),
  };
}

test("incremental race capture is settlement-parity exact across every timed type, overlap, transfer, copy, and floor", async () => {
  const participants = [
    { id: "p1", userId: "u1", bonusSteps: 2 },
    { id: "p2", userId: "u2", bonusSteps: 0 },
    { id: "p3", userId: "u3", bonusSteps: 0 },
  ];
  const [p1, p2, p3] = participants;
  const p1Effects = [
    row("01-runners-high", "RUNNERS_HIGH", p1, 0),
    row("02-rally", "RALLY_FLAG", p1, 2, { multiplier: 1.25 }),
    row("03-uprising", "UPRISING", p1, 4, { multiplier: 2 }),
    { ...row("04-rain", "RAINSTORM", p1, 6, { multiplier: 0.5 }), sourceUserId: "u2" },
    row("05-umbrella", "UMBRELLA", p1, 8),
    row("06-wrong", "WRONG_TURN", p1, 10),
    row("07-campfire", "CAMPFIRE_REST", p1, 12, {
      freezeMs: 8 * 60_000,
      multiplier: 2,
    }),
    row("08-ghost", "GHOST_PEPPER", p1, 14, {
      boostMs: 9 * 60_000,
      multiplier: 3,
    }),
    row("09-coin", "COIN_FLIP", p1, 16, { multiplier: 0.25 }),
    row("10-leg", "LEG_CRAMP", p1, 18),
    row("11-quicksand", "QUICKSAND", p1, 20),
    { ...row("12-leech", "LEECH", p1, 22, { ratio: 2 }), sourceUserId: "u2" },
  ];
  const p2Effects = [row("13-runners-high-p2", "RUNNERS_HIGH", p2, 24)];
  const hitchhike = {
    ...row("14-hitchhike", "HITCHHIKE", p1, 26, {
      scoringVersion: 2,
      copyRatio: 1,
    }),
    sourceUserId: p3.userId,
  };
  const effectsByParticipant = new Map([
    [p1.id, p1Effects],
    [p2.id, p2Effects],
    [p3.id, []],
  ]);
  const hitchhikes = [hitchhike];
  const effects = [...p1Effects, ...p2Effects, hitchhike]
    .sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt) ||
      a.id.localeCompare(b.id));
  const preLeech = participants.map((participant, index) => ({
    participant,
    baseAdjusted: [3, 41, 7][index],
    hasSampleData: true,
    frozen: false,
  }));
  const race = {
    id: "race",
    endsAt: now,
    targetSteps: 10_000,
    powerupsEnabled: true,
  };
  const stepSampleModel = samples();

  const effectModelFor = (includedIds) => ({
    async findEffectsForRaceByTypes(_raceId, participantId, types) {
      const byType = Object.fromEntries(types.map((type) => [type, []]));
      for (const effect of effectsByParticipant.get(participantId) || []) {
        if (includedIds.has(effect.id) && byType[effect.type]) {
          byType[effect.type].push(effect);
        }
      }
      return byType;
    },
    async findRaceEffectsByType(_raceId, type) {
      return type === "HITCHHIKE"
        ? hitchhikes.filter((effect) => includedIds.has(effect.id))
        : [];
    },
  });
  const score = async ({ effectIds }) => {
    const model = effectModelFor(effectIds);
    const active = [];
    for (const input of preLeech) {
      const recomputed = await calculateCurrentTotal({
        raceId: race.id,
        racePowerupsEnabled: true,
        participant: input.participant,
        baseAdjusted: input.baseAdjusted,
        hasSampleData: input.hasSampleData,
        raceActiveEffectModel: model,
        stepSampleModel,
        now,
      });
      active.push({
        participantId: input.participant.id,
        userId: input.participant.userId,
        preLeechTotal: recomputed.total,
        leechTransfers: recomputed.leechTransfers,
      });
    }
    const copies = await collectRaceHitchhikeCopies({
      raceId: race.id,
      raceEndsAt: race.endsAt,
      participants,
      raceActiveEffectModel: model,
      stepSampleModel,
      now,
    });
    return applyLeechTransfers(applyHitchhikeCopies(active, copies));
  };

  const legacy = await computeSettlementAttributionVector({
    participants,
    effects,
    score,
  });
  const incremental = await computeSelectedPrefixAttributionVector({
    participants,
    effects,
    selectedEffectIds: new Set([hitchhike.id]),
    scoreRawPrefixTerms: ({ orderedEffects }) =>
      captureIncrementalRacePrefixTerms({
        race,
        participants,
        preLeech,
        currentTime: now,
        effectsByParticipant,
        hitchhikes,
        orderedEffects,
        stepSampleModel,
        eventsByUserId: null,
      }),
  });

  assert.deepEqual(incremental.baselineTotals, legacy.baselineTotals);
  assert.deepEqual(incremental.finalTotals, legacy.finalTotals);
  assert.deepEqual(incremental.effectImpacts, legacy.effectImpacts);
  assert.equal(incremental.scorerCalls, 1);
  assert.deepEqual(
    new Set(p1Effects.map((effect) => effect.type)),
    new Set(SETTLEMENT_EFFECT_TYPES),
  );
});

test("effect attribution excludes overlapping global-event ownership exactly like settlement", async () => {
  const participant = { id: "p-global", userId: "u-global", bonusSteps: 0 };
  const effect = row("effect-global-overlap", "RUNNERS_HIGH", participant, 0);
  const globalEvent = {
    id: "global-overlap",
    startsAt: minute(5),
    endsAt: minute(65),
    multiplier: 2,
  };
  const participants = [participant];
  const effects = [effect];
  const stepSampleModel = samples();
  const preLeech = [{
    participant,
    baseAdjusted: 100,
    hasSampleData: true,
    frozen: false,
  }];
  const race = {
    id: "race",
    endsAt: now,
    targetSteps: 10_000,
    powerupsEnabled: true,
  };
  const score = async ({ effectIds, globalEvents }) => {
    const selectedEffects = effectIds.has(effect.id) ? [effect] : [];
    const modifiers = await require("../../src/modules/races/services/effectiveStepScoring")
      .computeEffectModifiers(
        selectedEffects,
        100,
        participant.userId,
        stepSampleModel,
        true,
        globalEvents.length ? { globalEvents, now } : null,
        now,
      );
    return new Map([[participant.id, Math.max(
      0,
      100 - modifiers.frozenSteps + modifiers.buffedSteps -
        2 * modifiers.reversedSteps + (modifiers.globalBoostedSteps || 0),
    )]]);
  };
  const legacy = await computeSettlementAttributionVector({
    participants,
    effects,
    globalEvents: [globalEvent],
    score,
  });
  const incremental = await computeSelectedPrefixAttributionVector({
    participants,
    effects,
    selectedEffectIds: new Set([effect.id]),
    scoreRawPrefixTerms: ({ orderedEffects }) =>
      captureIncrementalRacePrefixTerms({
        race,
        participants,
        preLeech,
        currentTime: now,
        effectsByParticipant: new Map([[participant.id, orderedEffects]]),
        hitchhikes: [],
        orderedEffects,
        stepSampleModel,
        eventsByUserId: new Map([[participant.userId, [globalEvent]]]),
      }),
  });
  assert.deepEqual(incremental.effectImpacts, legacy.effectImpacts);
});
