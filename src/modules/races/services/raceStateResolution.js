const { Race } = require("../models/race");
const { RaceParticipant } = require("../models/raceParticipant");
const { Steps } = require("../../steps/models/steps");
const { StepSample } = require("../../steps/models/stepSample");
const { RaceActiveEffect } = require("../../powerups/models/raceActiveEffect");
const { RacePowerupEvent } = require("../../powerups/models/racePowerupEvent");
const { GlobalStepEvent } = require("../../steps/models/globalStepEvent");
const { eventsForUser } = require("../../steps/services/globalStepEventEntitlement");
const {
  computeEffectModifiers,
  createIncrementalEffectScoreCapture,
  signedMultiplierForEffects,
  umbrellaAdjustedRainstorms,
} = require("./effectiveStepScoring");
const {
  signedMultiplierAt,
  multiplierBoundaries,
} = require("./effectMultiplier");
const {
  getTimeZoneParts,
  formatDateString,
  addDaysToDateString,
  parseDateString,
  zonedDateTimeToUtc,
} = require("../../../shared/time/week");
const { calculateSubsequentSteps } = require("../raceSteps");
const { computeBoxEffectiveSteps } = require("../../powerups/boxSteps");
const { raceTimeZone } = require("../raceTimeZone");
const {
  applyLeechTransfers,
  computeLeechEarnedTransfer,
  createIncrementalLeechTransferState,
} = require("../../powerups/leechTransfers");
const {
  collectRaceHitchhikeCopies,
  applyHitchhikeCopies,
  createIncrementalHitchhikeCopyCapture,
} = require("../../powerups/hitchhikeCopies");
const { nextRawSteps } = require("../../powerups/rawPosition");
const {
  POWERUP_EFFECT_TYPES,
  SETTLEMENT_EFFECT_TYPES,
} = require("./raceScoringEffectTypes");
const {
  prefetchRaceScoringModels: defaultPrefetchRaceScoringModels,
} = require("./raceScoringPrefetch");
const {
  computeSelectedPrefixAttributionVector,
} = require("./raceSettlementAttribution");
const {
  runWithPhaseQueryCounter,
} = require("../../../shared/http/requestQueryCounter");
const {
  SNAPSHOT_AT_EXPIRY_TYPES,
} = require("../../powerups/constants/expiryEffectTypes");
const { POWERUP_NAMES } = require("../../powerups/commands/rollPowerup");

const ACTIVE_NOTICE_TIMED_TYPES = new Set([
  "LEG_CRAMP",
  "QUICKSAND",
  "RUNNERS_HIGH",
  "WRONG_TURN",
  "CAMPFIRE_REST",
  "RAINSTORM",
  "UPRISING",
  "RALLY_FLAG",
  "COIN_FLIP",
  "GHOST_PEPPER",
  "LEECH",
  "HITCHHIKE",
]);

// Every effect type that calculateCurrentTotal folds into a participant's
// live total. Shared with prefetch paths (getHomeRaceCard) so a bulk effect
// fetch covers exactly the types the math will ask for.
// Leech (Item 2) is a step-affecting effect too, but it is fetched only via the
// BULK (findEffectsForRaceByTypes) path below — never the per-type fallback — so
// the settlement invariant test (which locks the per-type query set) stays
// green while production (which always has the bulk method) scores it. The
// value is folded into the total by the SAME computeEffectModifiers the display
// path uses, so display == settlement.
function getEffectiveStart(participant, raceStartedAt) {
  const joinedAt = participant.joinedAt || raceStartedAt;
  return joinedAt > raceStartedAt ? joinedAt : raceStartedAt;
}

async function calculateBaseAdjusted({
  participant,
  raceStartedAt,
  timeZone,
  stepsModel,
  stepSampleModel,
  now,
  raceEndsAt = null,
}) {
  const effectiveStart = getEffectiveStart(participant, raceStartedAt);
  const startParts = getTimeZoneParts(effectiveStart, timeZone);
  const startDate = formatDateString(
    startParts.year,
    startParts.month,
    startParts.day
  );
  const wallNowMs = new Date(now).getTime();
  const raceEndMs = raceEndsAt == null
    ? Number.POSITIVE_INFINITY
    : new Date(raceEndsAt).getTime();
  const deadlinePassed = Number.isFinite(raceEndMs) && raceEndMs <= wallNowMs;
  const scoringNow = new Date(deadlinePassed ? raceEndMs : wallNowMs);
  const nowParts = getTimeZoneParts(scoringNow, timeZone);
  const today = formatDateString(nowParts.year, nowParts.month, nowParts.day);
  const dayAfterStartDate = addDaysToDateString(startDate, 1);
  const dayAfterParsed = parseDateString(dayAfterStartDate);
  const nextStartDayMidnight = zonedDateTimeToUtc(
    {
      year: dayAfterParsed.year,
      month: dayAfterParsed.month,
      day: dayAfterParsed.day,
      hour: 0,
      minute: 0,
      second: 0,
    },
    timeZone
  );
  // Once the deadline has passed, keep the start-day slice inside the race
  // window. Active races deliberately keep reading through midnight because an
  // in-progress HealthKit bucket is stamped with a future periodEnd but its
  // entire `steps` value represents walking already observed by the client.
  const settledCutoff = deadlinePassed ? raceEndMs : Number.POSITIVE_INFINITY;
  const startDayWindowEnd = new Date(
    Math.min(nextStartDayMidnight.getTime(), settledCutoff)
  );

  // When the race begins EXACTLY at local midnight (midnight-aligned seeded
  // race, on-time / pre-registered entrant), the start day is a FULL day: pre-race
  // steps that day are impossible, so the daily total is safe to use as a fallback
  // when hourly samples haven't synced. Mid-day / late joiners stay sample-only.
  const startOfStartDay = zonedDateTimeToUtc(
    {
      year: startParts.year,
      month: startParts.month,
      day: startParts.day,
      hour: 0,
      minute: 0,
      second: 0,
    },
    timeZone
  );
  const startsAtLocalMidnight =
    effectiveStart.getTime() === startOfStartDay.getTime();

  let startDaySteps = 0;
  const startDaySamples = await stepSampleModel.sumStepsInWindow(
    participant.userId,
    effectiveStart,
    startDayWindowEnd
  );

  const startDayIsCompleteAtCutoff =
    !deadlinePassed || nextStartDayMidnight.getTime() <= raceEndMs;
  if (startsAtLocalMidnight && startDayIsCompleteAtCutoff) {
    const startDayRow = await stepsModel.findByUserIdAndDate(
      participant.userId,
      startDate
    );
    startDaySteps = Math.max(startDaySamples, startDayRow?.steps ?? 0);
  } else if (startDaySamples > 0) {
    startDaySteps = startDaySamples;
  }

  const subsequentSteps = await calculateSubsequentSteps({
    userId: participant.userId,
    dayAfterStartDate,
    today,
    timeZone,
    stepsModel,
    stepSampleModel,
    now: scoringNow,
    allowPartialDayDaily: !deadlinePassed,
  });

  // `hasSampleData` decides whether effect scoring uses the precise segment walk
  // or the crude snapshot fallback — for the WHOLE race, every recompute. Keying
  // it on the start-day sliver alone meant a race that began late at night (a
  // ~76-minute window while the player slept) pinned every participant to the
  // fallback permanently, where timed buffs clamp to zero and Leech is dropped
  // entirely (2026-07-26: 17 of 137 active participants). Widen it: if the start
  // day is empty, ask whether the player has ANY sample in the race window.
  //
  // Capability-detected so injected test fakes that only implement
  // sumStepsInWindow keep exactly their old behavior.
  let hasSampleData = startDaySamples > 0;
  if (!hasSampleData && typeof stepSampleModel.hasAnyInWindow === "function") {
    hasSampleData = await stepSampleModel.hasAnyInWindow(
      participant.userId,
      effectiveStart,
      scoringNow
    );
  }

  return {
    baseAdjusted: Math.max(0, startDaySteps + subsequentSteps),
    hasSampleData,
    effectiveStart,
  };
}

async function calculateCurrentTotal({
  raceId,
  racePowerupsEnabled,
  participant,
  baseAdjusted,
  hasSampleData,
  raceActiveEffectModel,
  stepSampleModel,
  globalEvents = [],
  now = null,
}) {
  let legCramps = [];
  let runnersHighs = [];
  let wrongTurns = [];
  let campfires = [];
  let rainstorms = [];
  let leeches = [];
  let uprisings = [];
  let rallyFlags = [];
  let coinFlips = [];
  let ghostPeppers = [];
  let umbrellas = [];

  if (racePowerupsEnabled) {
    // One query for all types when the model supports it (production always
    // does — it fetches the 5 core types + LEECH); fall back to per-type queries
    // for injected fakes, which cover only the 5 core types. Same rows, same
    // per-type order.
    let byType;
    if (typeof raceActiveEffectModel.findEffectsForRaceByTypes === "function") {
      byType = await raceActiveEffectModel.findEffectsForRaceByTypes(
        raceId,
        participant.id,
        SETTLEMENT_EFFECT_TYPES
      );
    } else {
      const lists = await Promise.all(
        POWERUP_EFFECT_TYPES.map((type) =>
          raceActiveEffectModel.findEffectsForRaceByType(
            raceId,
            participant.id,
            type
          )
        )
      );
      byType = Object.fromEntries(
        POWERUP_EFFECT_TYPES.map((t, i) => [t, lists[i]])
      );
    }
    legCramps = [...(byType.LEG_CRAMP || []), ...(byType.QUICKSAND || [])];
    runnersHighs = byType.RUNNERS_HIGH;
    wrongTurns = byType.WRONG_TURN;
    campfires = byType.CAMPFIRE_REST;
    rainstorms = byType.RAINSTORM;
    leeches = byType.LEECH || [];
    uprisings = byType.UPRISING || [];
    rallyFlags = byType.RALLY_FLAG || [];
    coinFlips = byType.COIN_FLIP || [];
    ghostPeppers = byType.GHOST_PEPPER || [];
    umbrellas = byType.UMBRELLA || [];
  }

  // Use the SAME computeEffectModifiers the display path uses, including the
  // additive global-event boost, so settlement totals match display exactly.
  const allEffects = [
    ...legCramps, ...runnersHighs, ...wrongTurns, ...campfires, ...rainstorms, ...leeches,
    ...uprisings, ...rallyFlags, ...coinFlips, ...ghostPeppers, ...umbrellas,
  ];
  const globalContext =
    globalEvents && globalEvents.length > 0 ? { globalEvents, now } : null;
  const { frozenSteps, buffedSteps, reversedSteps, globalBoostedSteps, leechTransfers } =
    await computeEffectModifiers(
      allEffects,
      baseAdjusted,
      participant.userId,
      stepSampleModel,
      hasSampleData,
      globalContext,
      now
    );

  // `total` here is the PRE-LEECH total (all other modifiers + bonus, floored at
  // 0). Leech is a cross-participant zero-sum TRANSFER, so the victim drain and
  // the attacker credit are resolved by the CALLER via applyLeechTransfers once
  // every participant's pre-leech total is known. `leechTransfers` lists the
  // leeches TARGETING this participant. A single-participant caller (sync-v2
  // reconcile) gets drain-only for that participant, which is the desired
  // uploader-only behavior.
  const total = Math.max(
    0,
    baseAdjusted -
      frozenSteps +
      buffedSteps -
      2 * reversedSteps +
      (globalBoostedSteps || 0) +
      (racePowerupsEnabled ? participant.bonusSteps || 0 : 0)
  );

  // Also expose the wave-5 groups (split coin flips) so settlement's
  // determineFinishSnapshot can interpolate finish time with the full §3
  // multiplier (e.g. a target crossed mid-pepper-boost). Additive to the return
  // shape — existing callers destructure only what they read.
  const coinFlipWins = coinFlips.filter((e) => Number((e.metadata || {}).multiplier) > 1);
  const coinFlipLoses = coinFlips.filter((e) => {
    const m = Number((e.metadata || {}).multiplier);
    return Number.isFinite(m) && m < 1;
  });
  // Batch 2026-08-10b item 6 / architect R9 — the rainstorm windows handed to
  // finish-time interpolation must be UMBRELLA-ADJUSTED, exactly like the ones
  // computeEffectModifiers just scored with. Until now this returned the raw
  // `byType.RAINSTORM` list and dropped `umbrellas` on the floor, so an
  // umbrella'd racer's finish-time multiplier was already wrong by a
  // subtractive 0.5; once the storm is multiplicative it would have been wrong
  // by a FACTOR on a buffed racer. Same helper, same nowMs, so display and
  // settlement agree by construction.
  const umbrellaNowMs = (now ? new Date(now) : new Date()).getTime();
  const effectiveRainstorms = umbrellaAdjustedRainstorms(
    rainstorms,
    umbrellas,
    umbrellaNowMs
  );

  return {
    total,
    currentMultiplierRaw: signedMultiplierForEffects(allEffects, umbrellaNowMs),
    leechTransfers,
    legCramps,
    runnersHighs,
    wrongTurns,
    campfires,
    rainstorms: effectiveRainstorms,
    uprisings,
    rallyFlags,
    coinFlipWins,
    coinFlipLoses,
    ghostPeppers,
  };
}

function buildBonusTimeline(events, participantUserId, effectiveStart, now) {
  const startMs = effectiveStart.getTime();
  const endMs = now.getTime();
  const bonuses = [];

  for (const event of events) {
    const eventTime = new Date(event.createdAt);
    const eventMs = eventTime.getTime();
    if (eventMs < startMs || eventMs > endMs) continue;

    const metadata = event.metadata || {};
    let delta = 0;

    if (
      event.actorUserId === participantUserId &&
      ["PROTEIN_SHAKE", "SECOND_WIND", "TRAIL_MIX"].includes(event.powerupType) &&
      typeof metadata.bonus === "number"
    ) {
      delta += metadata.bonus;
    }

    if (event.powerupType === "SHORTCUT" && typeof metadata.stolen === "number") {
      if (event.actorUserId === participantUserId) {
        delta += metadata.stolen;
      }
      if (event.targetUserId === participantUserId) {
        delta -= metadata.stolen;
      }
    }

    if (event.powerupType === "RED_CARD" && typeof metadata.penalty === "number") {
      if (event.targetUserId === participantUserId) {
        delta -= metadata.penalty;
      }
    }

    if (
      ["PINECONE_TOSS", "TRAIL_MINE"].includes(event.powerupType) &&
      typeof metadata.penalty === "number" &&
      event.targetUserId === participantUserId
    ) {
      delta -= metadata.penalty;
    }

    if (delta !== 0) {
      bonuses.push({ time: eventTime, delta });
    }
  }

  bonuses.sort((a, b) => a.time - b.time);
  return bonuses;
}

// Finish-time interpolation multiplier. Delegates to the shared signed m(t)
// (buff-stacking spec §3) so finish snapshots, live display, and settlement all
// score identically. `effectGroups` carries whatever groups the caller has;
// missing wave-5 groups default to none inside signedMultiplierAt.
function multiplierForTime(timeMs, effectGroups) {
  return signedMultiplierAt(timeMs, effectGroups);
}

async function determineFinishSnapshot({
  participant,
  currentTotal,
  targetSteps,
  effectiveStart,
  effectGroups,
  stepSampleModel,
  powerupEventModel,
  raceId,
  now,
}) {
  if (currentTotal < targetSteps) {
    return null;
  }

  const samples = await stepSampleModel.findByUserIdAndTimeRange(
    participant.userId,
    effectiveStart,
    now
  );
  const events = await powerupEventModel.findByRaceAsc(raceId);
  const bonusTimeline = buildBonusTimeline(
    events,
    participant.userId,
    effectiveStart,
    now
  );

  if (samples.length === 0 && bonusTimeline.length === 0) {
    return { finishedAt: now, finishTotalSteps: currentTotal };
  }

  const boundaries = new Set([
    effectiveStart.getTime(),
    now.getTime(),
    ...bonusTimeline.map((b) => b.time.getTime()),
  ]);

  for (const sample of samples) {
    const sampleStart = Math.max(
      effectiveStart.getTime(),
      new Date(sample.periodStart).getTime()
    );
    const sampleEnd = Math.min(now.getTime(), new Date(sample.periodEnd).getTime());
    if (sampleEnd > sampleStart) {
      boundaries.add(sampleStart);
      boundaries.add(sampleEnd);
    }
  }

  // Slice at every effect phase edge (pepper/uprising/campfire transitions
  // included) via the shared boundary set, clamped to [effectiveStart, now].
  for (const b of multiplierBoundaries(
    effectiveStart.getTime(),
    now.getTime(),
    effectGroups
  )) {
    boundaries.add(b);
  }

  const ordered = [...boundaries].sort((a, b) => a - b);
  let score = 0;
  let bonusIndex = 0;

  for (let i = 0; i < ordered.length; i++) {
    const boundary = ordered[i];

    while (
      bonusIndex < bonusTimeline.length &&
      bonusTimeline[bonusIndex].time.getTime() === boundary
    ) {
      score += bonusTimeline[bonusIndex].delta;
      if (score >= targetSteps) {
        return {
          finishedAt: new Date(boundary),
          finishTotalSteps: score,
        };
      }
      bonusIndex += 1;
    }

    const nextBoundary = ordered[i + 1];
    if (!nextBoundary || nextBoundary <= boundary) continue;

    const segmentDuration = nextBoundary - boundary;
    let stepRate = 0;

    for (const sample of samples) {
      const sampleStart = new Date(sample.periodStart).getTime();
      const sampleEnd = new Date(sample.periodEnd).getTime();
      if (sampleStart <= boundary && sampleEnd >= nextBoundary) {
        const sampleDuration = sampleEnd - sampleStart;
        if (sampleDuration > 0) {
          stepRate += sample.steps / sampleDuration;
        }
      }
    }

    if (stepRate <= 0) continue;

    const multiplier = multiplierForTime(boundary, effectGroups);
    const scoreRate = stepRate * multiplier;

    if (scoreRate > 0 && score < targetSteps) {
      const segmentGain = scoreRate * segmentDuration;
      if (score + segmentGain >= targetSteps) {
        const msToFinish = ((targetSteps - score) / scoreRate);
        return {
          finishedAt: new Date(boundary + msToFinish),
          finishTotalSteps: targetSteps,
        };
      }
    }

    score += scoreRate * segmentDuration;
  }

  return { finishedAt: now, finishTotalSteps: currentTotal };
}

async function triggerTrailMines({
  raceId,
  race = null,
  stepTotals,
  raceActiveEffectModel,
  participantModel,
  powerupEventModel,
  activeEffects = null,
  resolvedAt = new Date(),
  activeImpactEnabled,
}) {
  if (typeof raceActiveEffectModel.findActiveForRace !== "function") {
    return [];
  }
  const mines = (Array.isArray(activeEffects)
    ? activeEffects
    : await raceActiveEffectModel.findActiveForRace(raceId)).filter(
    (effect) => effect.type === "TRAIL_MINE"
  );

  const isTeamRace = race ? race.isTeamRace === true : false;
  const impacts = [];

  for (const mine of mines) {
    const metadata = mine.metadata || {};
    const ownerParticipantId = metadata.ownerParticipantId || mine.targetParticipantId;
    const positionSteps = metadata.positionSteps;
    const penaltyPercent = metadata.penaltyPercent;
    // C0: who was ALREADY past the mine when it was planted, recorded at plant
    // time from the same computed totals the plant position came from.
    //
    // This replaces the old heuristic "participant.totalSteps (the value stored
    // before this resolve) is below positionSteps". That heuristic silently
    // assumed the resolver was the only thing that ever advanced the stored
    // column. It no longer is: the uploader-only reconcile persists the SYNCING
    // user's own row inline (so their box state is current in the same request),
    // which meant the runner who actually crossed the mine arrived at the worker
    // already sitting above it and was read as "was always ahead" — the mine
    // would never fire for the person who tripped it.
    //
    // Recording the ahead-set at plant time states the rule directly instead of
    // inferring it, and is immune to who persisted what in between. Mines
    // planted by an older binary carry no `aheadParticipantIds`; those fall back
    // to the previous-total heuristic below, so in-flight mines keep working.
    const aheadAtPlant = Array.isArray(metadata.aheadParticipantIds)
      ? new Set(metadata.aheadParticipantIds)
      : null;

    if (typeof positionSteps !== "number" || typeof penaltyPercent !== "number") {
      continue;
    }

    // Team races (TR-653): a mine trips only for ENEMY-team members. Resolve
    // the owner's side from the resolved totals (the owner is always in them).
    const ownerTeam = isTeamRace
      ? stepTotals.find(({ participant }) => participant.id === ownerParticipantId)
          ?.participant?.team ?? null
      : null;

    const candidates = stepTotals
      .filter(({ participant, totalSteps }) => {
        if (participant.id === ownerParticipantId) return false;
        // TR-657: forfeited members are frozen and never trip mines.
        if (participant.forfeitedAt) return false;
        if (isTeamRace && ownerTeam && participant.team === ownerTeam) {
          return false;
        }
        // Must be at or past the mine now.
        if (totalSteps < positionSteps) return false;
        // …and must NOT have already been past it when it was planted.
        if (aheadAtPlant) return !aheadAtPlant.has(participant.id);
        const previousTotal = participant.totalSteps || 0;
        return previousTotal < positionSteps;
      })
      .sort((a, b) => a.totalSteps - b.totalSteps);

    const victim = candidates[0];
    if (!victim) continue;

    const shield = await raceActiveEffectModel.findActiveByTypeForParticipant(
      victim.participant.id,
      "COMPRESSION_SOCKS"
    );
    const nominalPenalty = Math.round(victim.totalSteps * penaltyPercent);
    let actualPenalty = 0;

    if (shield) {
      await raceActiveEffectModel.update(shield.id, { status: "BLOCKED" });
    } else if (nominalPenalty > 0) {
      const applied = await participantModel.subtractBonusSteps(
        victim.participant.id,
        nominalPenalty,
      );
      actualPenalty = Number.isFinite(Number(applied?.actualPenalty))
        ? Math.max(0, Number(applied.actualPenalty))
        : nominalPenalty;
      victim.totalSteps = Math.max(0, victim.totalSteps - actualPenalty);
    }

    await raceActiveEffectModel.update(mine.id, {
      status: "EXPIRED",
      ...(mine.metadata?.impactBoundaryV1
        ? {
            metadata: {
              ...(mine.metadata || {}),
              impactBoundaryV1: {
                ...mine.metadata.impactBoundaryV1,
                endReason: "TRIGGERED",
                endedAt: resolvedAt.toISOString(),
              },
            },
          }
        : {}),
    });
    const sourceFeedEvent = await powerupEventModel.create({
      raceId,
      actorUserId: mine.sourceUserId,
      eventType: shield ? "POWERUP_BLOCKED" : "POWERUP_USED",
      powerupType: "TRAIL_MINE",
      targetUserId: victim.participant.userId,
      description: shield
        ? `${victim.participant.user?.displayName || "A runner"} blocked a Trail Mine with Compression Socks!`
        : `${victim.participant.user?.displayName || "A runner"} triggered a Trail Mine and lost ${actualPenalty.toLocaleString()} steps.`,
      metadata: {
        mineId: mine.id,
        penalty: actualPenalty,
        penaltyPercent,
        positionSteps,
        blocked: Boolean(shield),
      },
    });
    impacts.push({
      effectId: mine.id,
      userId: victim.participant.userId,
      powerupType: "TRAIL_MINE",
      deltaSteps: shield ? 0 : -actualPenalty,
      resolvedAt,
      sourceFeedEventId: sourceFeedEvent?.id || null,
    });
  }
  return impacts;
}

async function judgeDrillSergeantEffects({
  race,
  stepTotals,
  activeEffects,
  participantModel,
  raceActiveEffectModel,
  powerupEventModel,
  stepSampleModel,
  currentTime,
  activeImpactEnabled,
}) {
  const impacts = [];
  const totalByParticipant = new Map(
    stepTotals.map((entry) => [entry.participant.id, entry])
  );
  for (const effect of activeEffects || []) {
    if (
      effect.type !== "DRILL_SERGEANT" ||
      !effect.expiresAt ||
      new Date(effect.expiresAt) > currentTime
    ) continue;
    const metadata = effect.metadata || {};
    const target = totalByParticipant.get(effect.targetParticipantId);
    const goalSteps = Number(metadata.goalSteps) || 3000;
    const configuredPenalty = Number(metadata.penaltySteps) || 1500;
    const windowStart = new Date(effect.startsAt);
    const windowEnd = new Date(effect.expiresAt);
    const windowSteps = typeof stepSampleModel.sumClosedStepsInWindow === "function"
      ? await stepSampleModel.sumClosedStepsInWindow(
          effect.targetUserId,
          windowStart,
          windowEnd,
          currentTime
        )
      : await stepSampleModel.sumStepsInWindow(
          effect.targetUserId,
          windowStart,
          windowEnd
        );
    let outcome = "SURVIVED";
    let deltaSteps = 0;
    if (windowSteps < goalSteps && target) {
      outcome = "FAILED";
      // A progress-triggered legacy boundary can have no retained samples even
      // though race_participants.total_steps is the last authoritative snapshot
      // the old endpoint exposed. Preserve that fallback contract while keeping
      // judgement inside C0: precise generations floor against the freshly
      // scored total; sample-less generations floor against the greater of the
      // fresh calculation and the committed snapshot.
      const availableSteps = target.hasSampleData
        ? target.totalSteps
        : Math.max(
            Math.round(Number(target.totalSteps) || 0),
            Math.round(Number(target.participant?.totalSteps) || 0)
          );
      if (!target.hasSampleData && availableSteps > target.totalSteps) {
        // The write-capture proxy floors penalties against its latest captured
        // participant total. Preserve the legacy sample-less snapshot before
        // recording the penalty, otherwise the earlier fresh-score capture (0
        // when no retained source rows exist) silently turns a valid 1,500-step
        // Drill consequence into a zero write at the C0 fence.
        await participantModel.updateTotalSteps(
          effect.targetParticipantId,
          availableSteps,
        );
        target.totalSteps = availableSteps;
      }
      const nominalPenalty = Math.max(
        0,
        Math.min(configuredPenalty, availableSteps)
      );
      let actualPenalty = 0;
      if (nominalPenalty > 0) {
        const applied = await participantModel.subtractBonusSteps(
          effect.targetParticipantId,
          nominalPenalty,
        );
        actualPenalty = Number.isFinite(Number(applied?.actualPenalty))
          ? Math.max(0, Number(applied.actualPenalty))
          : nominalPenalty;
        target.totalSteps = Math.max(0, target.totalSteps - actualPenalty);
      }
      deltaSteps = -actualPenalty;
    }
    await raceActiveEffectModel.update(effect.id, {
      status: "EXPIRED",
      metadata: {
        ...metadata,
        ...(metadata.impactBoundaryV1
          ? {
              impactBoundaryV1: {
                ...metadata.impactBoundaryV1,
                endReason: "JUDGED",
                endedAt: currentTime.toISOString(),
              },
            }
          : {}),
      },
    });
    const sourceFeedEvent = await powerupEventModel.create({
      raceId: race.id,
      actorUserId: outcome === "FAILED" ? effect.sourceUserId : effect.targetUserId,
      eventType: "POWERUP_USED",
      powerupType: "DRILL_SERGEANT",
      targetUserId: effect.targetUserId,
      description: outcome === "FAILED"
        ? `Dare failed! They fell short of ${goalSteps.toLocaleString()} steps and lost ${Math.abs(deltaSteps).toLocaleString()}.`
        : `Dare survived! They walked ${Math.round(windowSteps).toLocaleString()} steps and dodged the Drill Sergeant penalty.`,
      metadata: {
        outcome,
        ...(outcome === "FAILED" ? { penalty: Math.abs(deltaSteps) } : {}),
        windowSteps: Math.round(windowSteps),
      },
    });
    impacts.push({
      effectId: effect.id,
      userId: effect.targetUserId,
      powerupType: "DRILL_SERGEANT",
      deltaSteps,
      resolvedAt: effect.expiresAt || currentTime,
      sourceFeedEventId: sourceFeedEvent?.id || null,
    });
  }
  return impacts;
}

function chronologicalImpactEffects(rows = []) {
  return [...rows].sort((a, b) => {
    const time = new Date(a.startsAt || a.createdAt || 0).getTime() -
      new Date(b.startsAt || b.createdAt || 0).getTime();
    return time || String(a.id).localeCompare(String(b.id));
  });
}

async function captureIncrementalRacePrefixTerms({
  race,
  participants,
  preLeech,
  currentTime,
  effectsByParticipant,
  hitchhikes,
  orderedEffects,
  stepSampleModel,
  eventsByUserId,
}) {
  const allowedIds = new Set(orderedEffects.map((effect) => effect.id));
  const prefixEffectsByParticipant = new Map();
  const participantIdByEffectId = new Map();
  for (const participant of participants) {
    const rows = (effectsByParticipant.get(participant.id) || [])
      .filter((effect) => allowedIds.has(effect.id));
    prefixEffectsByParticipant.set(participant.id, rows);
    for (const effect of rows) participantIdByEffectId.set(effect.id, participant.id);
  }
  const prefixHitchhikes = (hitchhikes || [])
    .filter((effect) => allowedIds.has(effect.id));
  const participantById = new Map(participants.map((row) => [row.id, row]));
  const participantByUserId = new Map();
  for (const participant of participants) {
    if (!participantByUserId.has(participant.userId)) {
      participantByUserId.set(participant.userId, participant);
    }
  }
  const inputByParticipantId = new Map(
    preLeech.filter(Boolean).map((entry) => [entry.participant.id, entry]),
  );
  const frozenTotals = new Map(
    participants
      .filter((participant) => participant.forfeitedAt || participant.finishedAt)
      .map((participant) => [
        participant.id,
        participant.finishTotalSteps ?? participant.totalSteps ?? race.targetSteps,
      ]),
  );

  const localCaptureByParticipantId = new Map();
  const activeEntries = [];
  for (const participant of participants) {
    const input = inputByParticipantId.get(participant.id);
    if (!input || input.frozen) continue;
    const capture = await createIncrementalEffectScoreCapture({
      effects: prefixEffectsByParticipant.get(participant.id) || [],
      rawTotal: input.baseAdjusted,
      bonusSteps: race.powerupsEnabled ? participant.bonusSteps || 0 : 0,
      userId: participant.userId,
      stepSampleModel,
      hasSampleData: input.hasSampleData,
      now: currentTime,
      // Global events are separately owned settlement sources. They affect the
      // authoritative total, but never an individual active-effect marginal.
      globalEvents: [],
    });
    localCaptureByParticipantId.set(participant.id, capture);
    activeEntries.push({
      participantId: participant.id,
      userId: participant.userId,
      preLeechTotal: capture.getFlooredTotal(),
    });
  }

  const hitchCaptureById = new Map();
  const hitchCapturesByTargetParticipantId = new Map();
  for (const effect of prefixHitchhikes) {
    const target = participantById.get(effect.targetParticipantId) ||
      participantByUserId.get(effect.targetUserId) || null;
    const capture = await createIncrementalHitchhikeCopyCapture({
      effect,
      targetEffects: target
        ? prefixEffectsByParticipant.get(target.id) || []
        : [],
      stepSampleModel,
      now: currentTime,
      raceEndsAt: race.endsAt,
      targetFinishedAt: target?.finishedAt || null,
      targetForfeitedAt: target?.forfeitedAt || null,
      targetParticipantId: target?.id || effect.targetParticipantId,
      raceId: race.id,
      // Keep global-event ownership out of Hitchhike/effect attribution just as
      // computeSettlementAttributionVector does for every effect prefix.
      globalEvents: [],
    });
    hitchCaptureById.set(effect.id, capture);
    const targetParticipantId = target?.id || effect.targetParticipantId;
    if (targetParticipantId) {
      if (!hitchCapturesByTargetParticipantId.has(targetParticipantId)) {
        hitchCapturesByTargetParticipantId.set(targetParticipantId, []);
      }
      hitchCapturesByTargetParticipantId.get(targetParticipantId).push({ effect, capture });
    }
  }

  const earnedLeechById = new Map();
  for (const effect of orderedEffects) {
    if (effect.type !== "LEECH") continue;
    earnedLeechById.set(
      effect.id,
      await computeLeechEarnedTransfer(effect, stepSampleModel, currentTime),
    );
  }

  const leechState = createIncrementalLeechTransferState(activeEntries);
  const localTotalByParticipantId = new Map(
    activeEntries.map((entry) => [entry.participantId, entry.preLeechTotal]),
  );
  const hitchCreditByParticipantId = new Map();
  const includedHitchIds = new Set();
  const rawTermsByParticipant = new Map(
    participants.map((participant) => [participant.id, []]),
  );
  const withFrozenTotals = (totals) => {
    const result = new Map(totals);
    for (const [participantId, total] of frozenTotals) result.set(participantId, total);
    return result;
  };
  const baselineTotals = withFrozenTotals(leechState.getFinalTotals());
  let previousTotals = baselineTotals;

  const adjustHitchCredit = (sourceUserId, delta, affected) => {
    if (delta === 0) return;
    const participant = participantByUserId.get(sourceUserId);
    if (!participant || !localCaptureByParticipantId.has(participant.id)) return;
    hitchCreditByParticipantId.set(
      participant.id,
      (hitchCreditByParticipantId.get(participant.id) || 0) + delta,
    );
    affected.add(participant.id);
  };

  for (const effect of orderedEffects) {
    const affectedPreLeech = new Set();
    const localParticipantId = participantIdByEffectId.get(effect.id);
    if (localParticipantId) {
      const localCapture = localCaptureByParticipantId.get(localParticipantId);
      if (localCapture) {
        localCapture.applyEffect(effect);
        localTotalByParticipantId.set(
          localParticipantId,
          localCapture.getFlooredTotal(),
        );
        affectedPreLeech.add(localParticipantId);
      }
      for (const hitch of hitchCapturesByTargetParticipantId.get(localParticipantId) || []) {
        const before = hitch.capture.getCopiedSteps();
        hitch.capture.applyEffect(effect);
        const after = hitch.capture.getCopiedSteps();
        if (includedHitchIds.has(hitch.effect.id)) {
          adjustHitchCredit(hitch.effect.sourceUserId, after - before, affectedPreLeech);
        }
      }
    }

    if (effect.type === "HITCHHIKE") {
      const capture = hitchCaptureById.get(effect.id);
      if (capture) {
        const copied = capture.getCopiedSteps();
        includedHitchIds.add(effect.id);
        adjustHitchCredit(effect.sourceUserId, copied, affectedPreLeech);
      }
    }

    for (const participantId of affectedPreLeech) {
      leechState.setPreLeechTotal(
        participantId,
        Math.max(
          0,
          (localTotalByParticipantId.get(participantId) || 0) +
            (hitchCreditByParticipantId.get(participantId) || 0),
        ),
      );
    }

    if (effect.type === "LEECH" && localParticipantId) {
      leechState.addTransfer({
        effectId: effect.id,
        startsAt: effect.startsAt,
        sourceUserId: effect.sourceUserId,
        victimParticipantId: localParticipantId,
        earnedTransfer: earnedLeechById.get(effect.id) || 0,
      });
    }

    const nextTotals = withFrozenTotals(leechState.getFinalTotals());
    for (const participant of participants) {
      rawTermsByParticipant.get(participant.id).push({
        kind: "effect",
        effectId: effect.id,
        powerupType: effect.type,
        rawDelta: (Number(nextTotals.get(participant.id)) || 0) -
          (Number(previousTotals.get(participant.id)) || 0),
        orderKey: `0:${effect.id}`,
      });
    }
    previousTotals = nextTotals;
  }

  return {
    baselineTotals,
    finalTotals: previousTotals,
    rawTermsByParticipant,
  };
}

async function computeActiveTimedImpactCapture({
  race,
  participants,
  preLeech,
  currentTime,
  raceActiveEffectModel,
  stepSampleModel,
  eventsByUserId = null,
  selectedEffects = [],
}) {
  if (selectedEffects.length === 0) return { resolved: [], all: [], scorerCalls: 0 };
  const participantById = new Map(participants.map((row) => [row.id, row]));
  const participantByUserId = new Map(participants.map((row) => [row.userId, row]));
  const selectedIds = new Set(selectedEffects.map((effect) => effect.id));
  const recipientIds = new Set();
  for (const effect of selectedEffects) {
    if (effect.targetParticipantId) recipientIds.add(effect.targetParticipantId);
    if (effect.type === "LEECH" || effect.type === "HITCHHIKE") {
      const source = participantByUserId.get(effect.sourceUserId);
      if (source) recipientIds.add(source.id);
    }
  }
  const through = new Date(Math.max(
    ...selectedEffects.map((effect) => new Date(effect.startsAt).getTime()),
  ));
  const initialParticipants = [...recipientIds]
    .map((id) => participantById.get(id))
    .filter(Boolean);
  const firstPrefix = await raceActiveEffectModel.findActiveImpactPrefixEffects({
    raceId: race.id,
    participantIds: initialParticipants.map((row) => row.id),
    sourceUserIds: initialParticipants.map((row) => row.userId),
    types: [...ACTIVE_NOTICE_TIMED_TYPES],
    through,
  });

  // One bounded expansion covers every cross-recipient dependency: Leech can
  // credit its source, while Hitchhike needs its target's local modifier
  // prefix. Neither credit is recursively drainable/copyable, so no graph-wide
  // or participant-by-participant walk is required.
  const expandedIds = new Set();
  for (const effect of firstPrefix) {
    if (effect.type === "LEECH") {
      const source = participantByUserId.get(effect.sourceUserId);
      if (source && !recipientIds.has(source.id)) expandedIds.add(source.id);
    }
    if (effect.type === "HITCHHIKE" && effect.targetParticipantId &&
        !recipientIds.has(effect.targetParticipantId)) {
      expandedIds.add(effect.targetParticipantId);
    }
  }
  const expandedPrefix = expandedIds.size > 0
    ? await raceActiveEffectModel.findActiveImpactPrefixEffects({
        raceId: race.id,
        participantIds: [...expandedIds],
        sourceUserIds: [],
        types: [...ACTIVE_NOTICE_TIMED_TYPES],
        through,
      })
    : [];
  for (const id of expandedIds) recipientIds.add(id);
  const byId = new Map();
  for (const effect of [...firstPrefix, ...expandedPrefix, ...selectedEffects]) {
    byId.set(effect.id, effect);
  }
  const effects = chronologicalImpactEffects([...byId.values()]);
  const captureParticipants = [...recipientIds]
    .map((id) => participantById.get(id))
    .filter(Boolean);
  const effectsByParticipant = new Map(
    captureParticipants.map((participant) => [participant.id, []]),
  );
  for (const effect of effects) {
    if (effectsByParticipant.has(effect.targetParticipantId)) {
      effectsByParticipant.get(effect.targetParticipantId).push(effect);
    }
  }
  const hitchhikes = effects.filter((effect) => effect.type === "HITCHHIKE");
  const vector = await computeSelectedPrefixAttributionVector({
    participants: captureParticipants,
    effects,
    selectedEffectIds: selectedIds,
    // This is the canonical scorer's raw-term instrumentation seam. It accepts
    // the complete chronological prefix once, evaluates the already-prefetched
    // closure, and returns unrounded marginals. The attribution allocator then
    // runs exactly once over the complete vector; callers never subtract
    // independently rounded totals.
    scoreRawPrefixTerms: async ({ orderedEffects }) => {
      return captureIncrementalRacePrefixTerms({
        race,
        participants: captureParticipants,
        preLeech: preLeech.filter((entry) => recipientIds.has(entry.participant.id)),
        currentTime,
        effectsByParticipant,
        hitchhikes,
        orderedEffects,
        stepSampleModel,
        eventsByUserId,
      });
    },
  });
  const effectById = new Map(effects.map((effect) => [effect.id, effect]));
  const all = vector.effectImpacts
    .filter((impact) => {
      const effect = effectById.get(impact.effectId);
      return effect && ACTIVE_NOTICE_TIMED_TYPES.has(effect.type);
    })
    .map((impact) => ({
      ...impact,
      resolvedAt: effectById.get(impact.effectId)?.expiresAt || currentTime,
    }));
  return {
    all,
    resolved: vector.selectedEffectImpacts.map((impact) => ({
      ...impact,
      resolvedAt: effectById.get(impact.effectId)?.expiresAt || currentTime,
    })),
    scorerCalls: vector.scorerCalls,
  };
}

async function discoverActiveImpactSources({
  raceId,
  currentTime,
  raceActiveEffectModel,
  enabled,
  selectedSourceIds = null,
  freezeSourceIds = null,
}) {
  if (!enabled) {
    return { due: [], freeze: [], hasMore: false };
  }
  if (freezeSourceIds || selectedSourceIds) {
    const ids = [...new Set([
      ...(freezeSourceIds || []),
      ...(selectedSourceIds || []),
    ])];
    const selected = await raceActiveEffectModel.findActiveImpactSourcesByIds({
      raceId,
      sourceIds: ids,
      types: [...ACTIVE_NOTICE_TIMED_TYPES],
    });
    return {
      freeze: freezeSourceIds
        ? selected.filter((effect) => freezeSourceIds.has(effect.id))
        : [],
      due: freezeSourceIds
        ? []
        : selected.filter((effect) =>
            !effect.expiresAt || new Date(effect.expiresAt) <= currentTime
          ),
      hasMore: false,
    };
  }
  const due = await raceActiveEffectModel.findDueActiveImpactSourcesForRace({
    raceId,
    now: currentTime,
    types: [...ACTIVE_NOTICE_TIMED_TYPES],
    limit: 8,
  });
  return { due: due.slice(0, 8), freeze: [], hasMore: due.length > 8 };
}

function buildResolveRaceState(dependencies = {}) {
  const raceModel = dependencies.Race || Race;
  const participantModel = dependencies.RaceParticipant || RaceParticipant;
  const stepsModel = dependencies.Steps || Steps;
  const stepSampleModel = dependencies.StepSample || StepSample;
  const raceActiveEffectModel =
    dependencies.RaceActiveEffect || RaceActiveEffect;
  const powerupEventModel =
    dependencies.RacePowerupEvent || RacePowerupEvent;
  const globalStepEventModel =
    dependencies.GlobalStepEvent || GlobalStepEvent;
  const prefetchRaceScoringModels =
    dependencies.prefetchRaceScoringModels || defaultPrefetchRaceScoringModels;
  const logger = dependencies.logger || console;
  const recordPhaseTiming =
    typeof dependencies.recordPhaseTiming === "function"
      ? dependencies.recordPhaseTiming
      : null;
  const recordPhaseQueryCount =
    process.env.PRISMA_QUERY_EVENTS_ENABLED === "true" &&
    typeof dependencies.recordPhaseQueryCount === "function"
      ? dependencies.recordPhaseQueryCount
      : null;
  async function measureResolutionPhase(
    name,
    operation,
    { captureQueries = true } = {},
  ) {
    if (!recordPhaseTiming && !recordPhaseQueryCount) return operation();
    const startedAt = process.hrtime.bigint();
    const queryContext = recordPhaseQueryCount && captureQueries
      ? { count: 0 }
      : null;
    try {
      return queryContext
        ? await runWithPhaseQueryCounter(queryContext, operation)
        : await operation();
    } finally {
      try {
        recordPhaseTiming?.(
          name,
          Math.max(0, Number(process.hrtime.bigint() - startedAt) / 1e6),
        );
        if (queryContext) recordPhaseQueryCount(name, queryContext.count);
      } catch {}
    }
  }
  // Phase C4: every full-field reconciliation of a race runs under the shared
  // per-race advisory lock, so the four full-field paths (legacy /steps sync via
  // recordSteps/recordStepSamples, placementRecompute, usePowerup, and the durable
  // worker — all of which call resolveRaceState) are mutually exclusive on the
  // same race and never double-fire trail mines / lose participant updates.
  // Default is a PASSTHROUGH (no lock) so unit tests with injected fakes stay pure
  // and DB-free; the production singleton is built with the real Postgres advisory
  // lock. The worker therefore no longer wraps resolveRaceState itself (that would
  // nest the same xact lock across two transactions and self-deadlock).
  const withRaceResolutionLock =
    dependencies.withRaceResolutionLock || ((_raceId, callback) => callback());
  const now = dependencies.now || (() => new Date());
  const activeImpactConfigured = Object.prototype.hasOwnProperty.call(
    dependencies,
    "activeImpactEnabled",
  );
  const activeImpactEnabled = dependencies.activeImpactEnabled === true;
  const activeImpactSelectedSourceIds = dependencies.activeImpactSelectedSourceIds
    ? new Set(dependencies.activeImpactSelectedSourceIds)
    : null;
  const activeImpactFreezeSourceIds = dependencies.activeImpactFreezeSourceIds
    ? new Set(dependencies.activeImpactFreezeSourceIds)
    : null;

  // `userIds` (C0, spec §5a item 2) is ADDITIVE to the long-standing `userId`
  // argument: the race-keyed worker coalesces many uploaders into one resolve,
  // so it needs box-progress totals for EVERY user in the claimed job's
  // processing snapshot, not just the last one. Callers that pass only `userId`
  // are byte-for-byte unaffected — the returned `boxEffectiveSteps` still holds
  // that user's value.
  // `scoreParticipantIds` (dependency-closure spec, resolver-integration item 3)
  // is ADDITIVE and defaults to null = score the whole accepted field, which is
  // the only behavior any shipped caller gets. When present it is the planner's
  // sorted, bounded closure: Phase A computes and writes ONLY those rows.
  //
  // This is deliberately an option on the ONE canonical resolver rather than a
  // second scorer: item 3 forbids a copied scoring loop, and a fork would be a
  // second thing to keep byte-identical with every future scoring change.
  return async function resolveRaceState({
    raceId,
    userId,
    userIds = null,
    timeZone = "UTC",
    scoreParticipantIds = null,
    includeAllAcceptedBoxUsers = false,
  } = {}) {
    const boxUserIds = new Set(
      (Array.isArray(userIds) ? userIds : []).filter(Boolean)
    );
    if (userId) boxUserIds.add(userId);
    let races = [];

    if (raceId) {
      const race = await measureResolutionPhase("raceLoad", () =>
        typeof raceModel.findForResolution === "function"
          ? raceModel.findForResolution(raceId)
          : raceModel.findById(raceId)
      );
      if (race) races = [race];
    } else if (userId) {
      races = await measureResolutionPhase(
        "raceLoad",
        () => raceModel.findActiveForUser(userId)
      );
    }

    async function processRace(race) {
      if (race.status !== "ACTIVE" || !race.startedAt) {
        return null;
      }
      if (includeAllAcceptedBoxUsers) {
        for (const participant of race.participants || []) {
          if (
            participant.status === "ACCEPTED" &&
            !participant.finishedAt &&
            !participant.forfeitedAt &&
            participant.userId
          ) {
            boxUserIds.add(participant.userId);
          }
        }
      }

      // T9 defense-in-depth: once a race is past its endsAt it is awaiting the
      // raceExpiry cron to settle it (status is still ACTIVE in that gap). Stop
      // live-resolving it here — don't mark finishers, mint boxes, or complete
      // it; settlement (src/jobs/raceExpiry.js) owns the final standings. endsAt
      // null (open-ended target races) is unaffected.
      if (race.endsAt && now() >= new Date(race.endsAt)) {
        return null;
      }

      const acceptedParticipants = race.participants.filter(
        (p) => p.status === "ACCEPTED"
      );
      // The closure scope. `null` (every shipped caller) keeps the full field,
      // so the whole subset path is unreachable unless a caller opts in.
      //
      // Only the SCORE-AND-WRITE set narrows. `race.participants` stays the full
      // accepted roster everywhere it is read below — Phase A2's Hitchhike target
      // lookup needs targets outside the closure, and the returned `result.race`
      // must carry the full roster (architecture review 3, R9) or the
      // post-commit high-multiplier alert would silently shrink its recipients.
      const scoreScope =
        Array.isArray(scoreParticipantIds) && scoreParticipantIds.length > 0
          ? new Set(scoreParticipantIds)
          : null;
      const scoredParticipants = scoreScope
        ? acceptedParticipants.filter((p) => scoreScope.has(p.id))
        : acceptedParticipants;
      const currentTime = now();
      // Active-impact discovery starts with the exact partial/indexed due key.
      // No-due generations stop after this bounded selector; they never walk
      // participant histories merely to discover there is nothing to emit.
      const impactSources = await discoverActiveImpactSources({
        raceId: race.id,
        currentTime,
        raceActiveEffectModel,
        enabled: activeImpactEnabled,
        selectedSourceIds: activeImpactSelectedSourceIds,
        freezeSourceIds: activeImpactFreezeSourceIds,
      });
      const selectedDueImpactEffects = impactSources.due;
      const selectedFreezeImpactEffects = impactSources.freeze;
      const hasMoreTimedImpactSources = impactSources.hasMore;
      let prefetched = null;
      try {
        prefetched = await measureResolutionPhase(
          "scoringPrefetch",
          () => prefetchRaceScoringModels({
            races: [race],
            now: currentTime,
            stepsModel,
            stepSampleModel,
            raceActiveEffectModel,
            ...(scoreScope
              ? { scoringParticipantIds: [...scoreScope] }
              : {}),
          })
        );
      } catch (error) {
        // A bulk-read failure must not make resolution unavailable. Fall back
        // to the canonical per-participant model calls for this run.
        logger.error(
          `[RACE_RESOLUTION] scoring prefetch failed (race ${race.id}):`,
          error
        );
      }
      const scoringStepsModel = prefetched?.stepsModel || stepsModel;
      const scoringStepSampleModel =
        prefetched?.stepSampleModel || stepSampleModel;
      const prefetchedEffectModel =
        prefetched?.raceActiveEffectModel || raceActiveEffectModel;
      // Bound Phase A2's copy work to links whose CASTER is in the closure.
      //
      // Done by narrowing the model's one bulk read rather than by editing the
      // Phase A2 call, which stays literally unchanged (spec Phase 3 note). The
      // filter is parity-exact, not an approximation: `applyHitchhikeCopies`
      // credits per SOURCE userId and drops any caster absent from the entry
      // list, so a link whose caster is outside the closure contributes exactly
      // nothing to a closure participant's total. Dropping it therefore changes
      // no number — it only skips the per-link step-sample read that would have
      // computed a credit destined for the floor, which is what keeps the
      // closure's scoring cost O(C) instead of O(links-in-race).
      //
      // ONLY `findRaceEffectsByType` is intercepted. `computeHitchhikeCopiedSteps`
      // reaches back through this same model for the v2 scoring version via
      // `findEffectsForRaceByTypes`, and `triggerTrailMines`/`calculateCurrentTotal`
      // use `findActiveForRace`/`findEffectsForRaceByTypes` — all pass straight
      // through untouched.
      //
      // Built as a SPREAD, not `Object.create`: these effect models are passed
      // around and re-wrapped by spread elsewhere (raceScoringPrefetch.js's
      // `scopedEffects` does exactly `{...raceActiveEffectModel, ...}`), and a
      // spread copies only OWN ENUMERABLE properties. A prototype-delegating
      // wrapper — or an own property defined with `Object.defineProperty`,
      // which is non-enumerable by default — would be silently dropped by the
      // next spread, quietly restoring the unbounded read.
      const scoringEffectModel =
        scoreScope && typeof prefetchedEffectModel.findRaceEffectsByType === "function"
          ? {
            ...prefetchedEffectModel,
            findRaceEffectsByType: async (...args) => {
              const rows =
                  (await prefetchedEffectModel.findRaceEffectsByType(...args)) || [];
              const casterUserIds = new Set(
                scoredParticipants.map((p) => p.userId)
              );
              return rows.filter((row) => casterUserIds.has(row.sourceUserId));
            },
          }
          : prefetchedEffectModel;

      // Fetch GlobalStepEvents overlapping [race start, now] once per race and
      // hand them to the SHARED math so this path matches getRaceProgress.
      // Read defensively: any failure or missing model => no boost.
      let globalEvents = [];
      let eventsByUserId = null;
      if (typeof globalStepEventModel.findEligibleByRace === "function") {
        eventsByUserId = await measureResolutionPhase(
          "globalEvents",
          () => globalStepEventModel.findEligibleByRace({
            raceId: race.id,
            // A dependency-closure run scores only its bounded participant
            // set. Event entitlement is user-local, so loading eligibility for
            // the other 9,999 members adds no scoring input and turns an O(C)
            // resolution back into O(field size) during the daily event.
            userIds: scoredParticipants.map((participant) => participant.userId),
            rangeStart: race.startedAt,
            rangeEnd: currentTime,
          })
        );
        const seen = new Map();
        for (const participant of scoredParticipants) {
          for (const event of eventsForUser(eventsByUserId, participant.userId)) {
            seen.set(`${event.entitlementId || event.id}:${participant.userId}`, event);
          }
        }
        globalEvents = [...seen.values()];
      } else {
        try {
          globalEvents = (await measureResolutionPhase(
            "globalEvents",
            () => globalStepEventModel.findActiveInRange(race.startedAt, currentTime)
          )) || [];
        } catch {
          globalEvents = [];
        }
        eventsByUserId = new Map(
          acceptedParticipants.map((participant) => [participant.userId, globalEvents])
        );
      }

      // Per-participant compute+write phase. Each iteration reads only this
      // participant's step_samples/race_active_effects and writes only this
      // participant's row, so we can fan them out in parallel safely. The one
      // ordering dependent (trailMines) runs after.
      const stepTotals = new Array(scoredParticipants.length);
      // Box-progress total for the requesting user (Leg Cramp + Wrong Turn
      // immune). Threaded to syncRacePowerupState so the roll gate ignores those
      // debuffs. Only the userId participant's value is needed (the caller syncs
      // for that user); stays null when resolveRaceState is called without userId.
      let userBoxEffectiveSteps = null;
      // Same value keyed by user, for every id in `boxUserIds`. Written from
      // inside the per-participant Promise.all — safe because each iteration
      // writes a DISTINCT key and JS is single-threaded between awaits.
      const boxEffectiveStepsByUser = new Map();
      // C3 (spec §5 Phase D step 8): the RAW walked total per participant, which
      // getRaceProgress used to hand to expireEffects on every poll. Now that the
      // request path no longer runs expireEffects, the worker does — and it needs
      // this map for the SNAPSHOT_AT_EXPIRY_TYPES stepsAtExpiry stamp and for the
      // Drill Sergeant judgement. Additive: existing callers destructure only
      // what they read.
      const baseAdjustedByParticipantId = {};

      // Phase A: compute each participant's PRE-LEECH total + the leeches
      // targeting them, WITHOUT writing yet — leech is a cross-participant zero-sum
      // transfer resolved race-wide in phase B (applyLeechTransfers) so display,
      // settlement, and this path agree. `preLeech[index]` holds either a frozen
      // total or {preLeechTotal, leechTransfers}. Writes are deferred to phase B.
      const preLeech = new Array(scoredParticipants.length);
      await measureResolutionPhase("participantScoring", () => Promise.all(
        scoredParticipants.map(async (participant, index) => {
          // TR-601: forfeited team-race members are FROZEN at the total the
          // forfeit command snapshotted — never recomputed here (their timed
          // effects expire naturally but the frozen number stands).
          if (participant.forfeitedAt) {
            preLeech[index] = {
              participant,
              frozen: true,
              totalSteps: Math.max(0, Number(participant.totalSteps) || 0),
            };
            return;
          }

          if (participant.finishedAt) {
            // Read-only — increment outside Promise.all is unsafe, count later.
            preLeech[index] = {
              participant,
              frozen: true,
              totalSteps:
                participant.finishTotalSteps ?? participant.totalSteps,
            };
            return;
          }

          const { baseAdjusted, hasSampleData, effectiveStart } =
            await calculateBaseAdjusted({
              participant,
              raceStartedAt: race.startedAt,
              // Seeded races score in their canonical tz so live placement
              // recompute agrees with getRaceProgress and settlement; user races
              // use the resolve caller's tz (legacy, default UTC).
              timeZone: raceTimeZone(race, timeZone),
              stepsModel: scoringStepsModel,
              stepSampleModel: scoringStepSampleModel,
              now: currentTime,
              raceEndsAt: race.endsAt,
            });

          const { total, leechTransfers, currentMultiplierRaw } =
            await calculateCurrentTotal({
              raceId: race.id,
              racePowerupsEnabled: race.powerupsEnabled,
              participant,
              baseAdjusted,
              hasSampleData,
              raceActiveEffectModel: scoringEffectModel,
              stepSampleModel: scoringStepSampleModel,
              globalEvents: eventsForUser(eventsByUserId, participant.userId),
              now: currentTime,
            });

          baseAdjustedByParticipantId[participant.id] = baseAdjusted;
          preLeech[index] = {
            participant,
            frozen: false,
            baseAdjusted,
            hasSampleData,
            preLeechTotal: total,
            leechTransfers,
            currentMultiplierRaw,
          };

          // Capture the requesting user's RAW-walked-steps box total for the gate
          // (immune to every buff/debuff multiplier; never strands next_box). Box
          // progress buckets days in boxTz = raceTimeZone(race, "UTC") — the race's
          // canonical persisted tz if set, else the constant "UTC" (NEVER the
          // caller's tz, so it stays device-independent and can't clamp flat for
          // non-UTC users). This is the SAME rule the display path uses. For a
          // race with a canonical tz the leaderboard `baseAdjusted` just computed
          // above is already bucketed in boxTz, so reuse it — box == leaderboard by
          // construction; only a null-tz race recomputes in the fixed boxTz.
          if (boxUserIds.has(participant.userId)) {
            const boxTz = raceTimeZone(race, "UTC");
            let boxBaseAdjusted;
            if (raceTimeZone(race, timeZone) === boxTz) {
              boxBaseAdjusted = baseAdjusted;
            } else {
              ({ baseAdjusted: boxBaseAdjusted } = await calculateBaseAdjusted({
                participant,
                raceStartedAt: race.startedAt,
                timeZone: boxTz,
                stepsModel: scoringStepsModel,
                stepSampleModel: scoringStepSampleModel,
                now: currentTime,
                raceEndsAt: race.endsAt,
              }));
            }
            const boxSteps = computeBoxEffectiveSteps({
              baseAdjusted: boxBaseAdjusted,
              bonusSteps: participant.bonusSteps || 0,
              maxBonusSteps: participant.maxBonusSteps || 0,
            });
            boxEffectiveStepsByUser.set(participant.userId, boxSteps);
            if (userId && participant.userId === userId) {
              userBoxEffectiveSteps = boxSteps;
            }
          }

          // TR-902: races are TIME-BASED only — there is no target-based early
          // finish. A race is decided when ends_at passes (src/jobs/raceExpiry.js)
          // or, for a team race, by collapse (commands/forfeitRace.js).
          // `targetSteps` survives as a DISPLAY goal (legacy client UI, seeded
          // Daily 10K / Weekly 50K) and completes nothing. Legacy rows that
          // already carry finishedAt keep their frozen totals (handled above).
        })
      ));

      // Phase A2 — HITCHHIKE (§7.3). Identical to the display path's insertion in
      // getRaceProgress: ONE bulk query for every link in the race, folded into
      // the CASTER's pre-leech total BEFORE the leech resolution so copied steps
      // are drainable. Adding it here but not there (or vice versa) is the
      // live-vs-settlement divergence §7.3 warns about — it would surface as the
      // score changing at race end. The parity guard in
      // test/queries/hitchhikeScoring.test.js fails if the two drift.
      const hitchhikeCopies = race.powerupsEnabled
        ? await measureResolutionPhase(
            "hitchhikeCopies",
            () => collectRaceHitchhikeCopies({
              raceId: race.id,
              raceEndsAt: race.endsAt,
              participants: race.participants,
              raceActiveEffectModel: scoringEffectModel,
              stepSampleModel: scoringStepSampleModel,
              now: currentTime,
              raceTimezone: race.timezone || "UTC",
              globalEvents,
              eventsByUserId,
            })
          )
        : [];

      // Phase B: resolve all leeches race-wide against real victim availability
      // (zero-sum, deterministic), then persist each active participant's FINAL
      // total. Frozen participants keep their stored total and are never written.
      let resultLeechResolutions = [];
      await measureResolutionPhase("leechAndCapture", async () => {
        const leechResolutions = [];
        const leechFinals = applyLeechTransfers(
          applyHitchhikeCopies(
            preLeech
              .filter((e) => e && !e.frozen)
              .map((e) => ({
                participantId: e.participant.id,
                userId: e.participant.userId,
                preLeechTotal: e.preLeechTotal,
                leechTransfers: e.leechTransfers,
              })),
            hitchhikeCopies
          ),
          { onTransfer: (resolution) => leechResolutions.push(resolution) }
        );

        for (let index = 0; index < preLeech.length; index++) {
          const e = preLeech[index];
          if (e.frozen) {
            stepTotals[index] = {
              participant: e.participant,
              totalSteps: Math.max(0, Number(e.totalSteps) || 0),
              hasSampleData: false,
            };
            continue;
          }
          const finalTotal = leechFinals.get(e.participant.id) ?? e.preLeechTotal;
          // Under the prod configuration this write is CAPTURED, not executed —
          // the v2 worker replays it inside its fence.
          await participantModel.updateStepTotals(e.participant.id, {
            totalSteps: finalTotal,
            rawSteps: nextRawSteps(
              e.participant.rawSteps,
              baseAdjustedByParticipantId[e.participant.id]
            ),
          });
          stepTotals[index] = {
            participant: e.participant,
            totalSteps: finalTotal,
            hasSampleData: e.hasSampleData,
          };
        }
        // This generation-owned capture is presentation attribution input only.
        // It is consumed under the worker's existing C0 write fence and never
        // changes participant totals.
        resultLeechResolutions = leechResolutions;
      });

      let timedImpactResolutions = [];
      let freezeTimedImpactResolutions = [];
      let timedImpactScorerCalls = 0;
      const activeEffects =
        race.powerupsEnabled && typeof scoringEffectModel.findActiveForRace === "function"
          ? (await measureResolutionPhase(
              "activeEffects",
              () => scoringEffectModel.findActiveForRace(race.id)
            )) || []
          : [];
      const selectedDueImpactIds = new Set(
        selectedDueImpactEffects.map((effect) => effect.id),
      );
      const selectedCaptureIds = new Set([
        ...selectedDueImpactIds,
        ...selectedFreezeImpactEffects.map((effect) => effect.id),
      ]);
      if (
        selectedCaptureIds.size > 0 &&
        !scoreScope &&
        race.powerupsEnabled
      ) {
        try {
          const timedCapture = await measureResolutionPhase(
            "activeImpactAttribution",
            () => measureResolutionPhase(
              "activeTimedImpactAttribution",
              () => computeActiveTimedImpactCapture({
                race,
                participants: acceptedParticipants,
                preLeech,
                currentTime,
                raceActiveEffectModel: scoringEffectModel,
                stepSampleModel: scoringStepSampleModel,
                eventsByUserId,
                selectedEffects: [
                  ...selectedDueImpactEffects,
                  ...selectedFreezeImpactEffects,
                ],
              }),
            ),
            { captureQueries: false },
          );
          timedImpactResolutions = timedCapture.resolved.filter((impact) =>
            selectedDueImpactIds.has(impact.effectId)
          );
          const freezeSourceIds = new Set(
            selectedFreezeImpactEffects.map((effect) => effect.id),
          );
          freezeTimedImpactResolutions = timedCapture.resolved
            .filter((impact) => freezeSourceIds.has(impact.effectId))
            .map((impact) => ({ ...impact, resolvedAt: currentTime }));
          timedImpactScorerCalls = timedCapture.scorerCalls || 0;
          if (timedImpactScorerCalls > 2 * selectedCaptureIds.size + 1) {
            throw new Error("ACTIVE_IMPACT_SCORER_BUDGET_EXCEEDED");
          }
          for (const effect of selectedDueImpactEffects) {
            const metadata = { ...(effect.metadata || {}) };
            const naturalExpiry =
              metadata.impactBoundaryV1?.endReason == null ||
              metadata.impactBoundaryV1.endReason === "NATURAL";
            if (SNAPSHOT_AT_EXPIRY_TYPES.includes(effect.type)) {
              const snapshot = baseAdjustedByParticipantId[effect.targetParticipantId];
              if (snapshot !== undefined) metadata.stepsAtExpiry = snapshot;
            }
            await raceActiveEffectModel.update(effect.id, {
              status: "EXPIRED",
              expiresAt: effect.expiresAt,
              metadata,
            });
            // Frozen clients still render the ordinary race feed. Resolved-
            // impact v2 owns the expiry transition, but it must preserve the
            // historical public EFFECT_EXPIRED row atomically with that
            // transition; otherwise those clients see an activation that
            // never wears off even though the private impact ledger resolves.
            const expiryEvent = await powerupEventModel.create({
              raceId: race.id,
              actorUserId: effect.targetUserId,
              eventType: "EFFECT_EXPIRED",
              powerupType: effect.type,
              description: naturalExpiry
                ? `${POWERUP_NAMES[effect.type] || effect.type} wore off.`
                : `${POWERUP_NAMES[effect.type] || effect.type} ended early.`,
            });
            timedImpactResolutions = timedImpactResolutions.map((impact) =>
              impact.effectId === effect.id
                ? {
                    ...impact,
                    sourceFeedEventId: expiryEvent?.id || null,
                    naturalExpiry,
                  }
                : impact,
            );
          }
        } catch (error) {
          logger.error("[RACE_RESOLUTION] active impact attribution failed", {
            errorCode: error?.code || "ATTRIBUTION_ERROR",
          });
          // The selected sources must transition atomically with their private
          // events. Swallowing attribution failure lets the later expiry path
          // mark them EXPIRED with no durable event and no continuation. Abort
          // this generation so the queue's normal retry owns eventual delivery.
          throw error;
        }
      }

      const drillSergeantImpacts = race.powerupsEnabled
        ? (await measureResolutionPhase(
            "activeEffects",
            () => judgeDrillSergeantEffects({
              race,
              stepTotals,
              activeEffects,
              participantModel,
              raceActiveEffectModel: scoringEffectModel,
              powerupEventModel,
              stepSampleModel: scoringStepSampleModel,
              currentTime,
              activeImpactEnabled: activeImpactConfigured
                ? activeImpactEnabled
                : undefined,
            })
          )) || []
        : [];

      // Freeze the exact pre-detonation standings exposed by the HTTP display
      // path. Drill judgement has already applied; Trail Mine continues against
      // this mutable array so both consequence commits replay under one fence.
      const preMineStepTotals = stepTotals.map(({ participant, totalSteps }) => ({
        participantId: participant.id,
        userId: participant.userId,
        totalSteps,
      }));

      let trailMineImpacts = [];
      if (race.powerupsEnabled) {
        trailMineImpacts = (await measureResolutionPhase(
          "trailMines",
          () => triggerTrailMines({
            raceId: race.id,
            race,
            stepTotals,
            raceActiveEffectModel: scoringEffectModel,
            participantModel,
            powerupEventModel,
            activeEffects,
            resolvedAt: currentTime,
            activeImpactEnabled: activeImpactConfigured
              ? activeImpactEnabled
              : undefined,
          })
        )) || [];
      }

      const currentMs = currentTime.getTime();
      const currentMultiplierByParticipantId = Object.fromEntries(
        preLeech.map((entry) => {
          const activeGlobalEvent = eventsForUser(
            eventsByUserId,
            entry.participant.userId
          ).find((event) => {
            const startsAt = new Date(event.startsAt).getTime();
            const endsAt = new Date(event.endsAt).getTime();
            return startsAt <= currentMs && currentMs < endsAt && Number(event.multiplier) > 1;
          });
          const globalMultiplier = activeGlobalEvent
            ? Number(activeGlobalEvent.multiplier)
            : 1;
          return [
            entry.participant.id,
            (entry.frozen ? 1 : entry.currentMultiplierRaw ?? 1) * globalMultiplier,
          ];
        })
      );

      return {
        raceId: race.id,
        race, // expose so callers can hand it to syncRacePowerupState (avoids a duplicate findById)
        boxEffectiveSteps: userBoxEffectiveSteps, // Leg Cramp + Wrong Turn immune; null if no userId
        // Additive (C0): the same figure for every requested user. Existing
        // callers destructure only what they read, so this is inert for them.
        boxEffectiveStepsByUser: Object.fromEntries(boxEffectiveStepsByUser),
        // C3: participantId -> RAW walked steps, for the worker-side expireEffects.
        baseAdjustedByParticipantId,
        displayCapture: {
          stepTotals: preMineStepTotals,
          currentMultiplierByParticipantId,
          activeEffects,
          asOf: currentTime,
        },
        activeImpactCapture: {
          asOf: currentTime,
          sourceEligibilityEnabled: activeImpactEnabled,
          leechResolutions: resultLeechResolutions,
          hitchhikeCopies,
          timedImpacts: timedImpactResolutions,
          freezeTimedImpacts: freezeTimedImpactResolutions,
          trailMineImpacts,
          drillSergeantImpacts,
          hasMoreTimedSources: hasMoreTimedImpactSources,
          timedScorerCalls: timedImpactScorerCalls,
        },
        updatedParticipants: stepTotals.length,
        // Retained (always 0) so existing callers reading this keep working.
        newFinishers: 0,
      };
    }

    // Process races sequentially in stable sorted (by id) order, each under its
    // own per-race advisory lock. Sequential + one-lock-at-a-time keeps the
    // Postgres connection pool bounded (one lock-holding transaction at a time)
    // and is deadlock-free regardless of order because no actor ever holds two
    // race locks simultaneously. Races are independent, so serializing them does
    // not change any per-race result; only cross-actor interleaving is prevented.
    const orderedRaces = [...races].sort((a, b) =>
      String(a.id).localeCompare(String(b.id))
    );
    const processed = [];
    for (const race of orderedRaces) {
      const result = await withRaceResolutionLock(race.id, () => processRace(race));
      if (result) processed.push(result);
    }
    return processed;
  };
}

const {
  withRaceResolutionLock: realWithRaceResolutionLock,
} = require("./withRaceResolutionLock");

// Production singleton locks each race with the real Postgres advisory lock.
const resolveRaceState = buildResolveRaceState({
  withRaceResolutionLock: realWithRaceResolutionLock,
});

module.exports = {
  POWERUP_EFFECT_TYPES,
  SETTLEMENT_EFFECT_TYPES,
  calculateBaseAdjusted,
  calculateSubsequentSteps,
  calculateCurrentTotal,
  captureIncrementalRacePrefixTerms,
  computeActiveTimedImpactCapture,
  discoverActiveImpactSources,
  triggerTrailMines,
  buildResolveRaceState,
  determineFinishSnapshot,
  resolveRaceState,
};
