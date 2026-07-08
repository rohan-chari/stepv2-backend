const { Race } = require("../models/race");
const { RaceParticipant } = require("../models/raceParticipant");
const { Steps } = require("../models/steps");
const { StepSample } = require("../models/stepSample");
const { RaceActiveEffect } = require("../models/raceActiveEffect");
const { RacePowerupEvent } = require("../models/racePowerupEvent");
const { GlobalStepEvent } = require("../models/globalStepEvent");
const { completeRace } = require("../commands/completeRace");
const { computeEffectModifiers } = require("../queries/getRaceProgress");
const {
  getTimeZoneParts,
  formatDateString,
  addDaysToDateString,
  parseDateString,
  zonedDateTimeToUtc,
} = require("../utils/week");
const { calculateSubsequentSteps } = require("../utils/raceSteps");
const { computeBoxEffectiveSteps } = require("../utils/boxSteps");
const { raceTimeZone } = require("../utils/raceTimeZone");

// Every effect type that calculateCurrentTotal folds into a participant's
// live total. Shared with prefetch paths (getHomeRaceCard) so a bulk effect
// fetch covers exactly the types the math will ask for.
const POWERUP_EFFECT_TYPES = [
  "LEG_CRAMP",
  "RUNNERS_HIGH",
  "WRONG_TURN",
  "CAMPFIRE_REST",
  "RAINSTORM",
];

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
}) {
  const effectiveStart = getEffectiveStart(participant, raceStartedAt);
  const startParts = getTimeZoneParts(effectiveStart, timeZone);
  const startDate = formatDateString(
    startParts.year,
    startParts.month,
    startParts.day
  );
  const nowParts = getTimeZoneParts(now, timeZone);
  const today = formatDateString(nowParts.year, nowParts.month, nowParts.day);
  const dayAfterStartDate = addDaysToDateString(startDate, 1);
  const dayAfterParsed = parseDateString(dayAfterStartDate);
  const startDayWindowEnd = zonedDateTimeToUtc(
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

  if (startsAtLocalMidnight) {
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
    now,
  });

  return {
    baseAdjusted: Math.max(0, startDaySteps + subsequentSteps),
    hasSampleData: startDaySamples > 0,
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

  if (racePowerupsEnabled) {
    const EFFECT_TYPES = POWERUP_EFFECT_TYPES;
    // One query for all five types when the model supports it; fall back to
    // per-type queries for injected fakes. Same rows, same per-type order.
    let byType;
    if (typeof raceActiveEffectModel.findEffectsForRaceByTypes === "function") {
      byType = await raceActiveEffectModel.findEffectsForRaceByTypes(
        raceId,
        participant.id,
        EFFECT_TYPES
      );
    } else {
      const lists = await Promise.all(
        EFFECT_TYPES.map((type) =>
          raceActiveEffectModel.findEffectsForRaceByType(
            raceId,
            participant.id,
            type
          )
        )
      );
      byType = Object.fromEntries(EFFECT_TYPES.map((t, i) => [t, lists[i]]));
    }
    legCramps = byType.LEG_CRAMP;
    runnersHighs = byType.RUNNERS_HIGH;
    wrongTurns = byType.WRONG_TURN;
    campfires = byType.CAMPFIRE_REST;
    rainstorms = byType.RAINSTORM;
  }

  // Use the SAME computeEffectModifiers the display path uses, including the
  // additive global-event boost, so settlement totals match display exactly.
  const allEffects = [...legCramps, ...runnersHighs, ...wrongTurns, ...campfires, ...rainstorms];
  const globalContext =
    globalEvents && globalEvents.length > 0 ? { globalEvents, now } : null;
  const { frozenSteps, buffedSteps, reversedSteps, globalBoostedSteps } =
    await computeEffectModifiers(
      allEffects,
      baseAdjusted,
      participant.userId,
      stepSampleModel,
      hasSampleData,
      globalContext
    );

  const total = Math.max(
    0,
    baseAdjusted -
      frozenSteps +
      buffedSteps -
      2 * reversedSteps +
      (globalBoostedSteps || 0) +
      (racePowerupsEnabled ? participant.bonusSteps || 0 : 0)
  );

  return { total, legCramps, runnersHighs, wrongTurns, campfires, rainstorms };
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

function multiplierForTime(timeMs, {
  legCramps,
  runnersHighs,
  wrongTurns,
  campfires = [],
  rainstorms = [],
}) {
  const isActive = (effect) => {
    const startMs = new Date(effect.startsAt).getTime();
    const endMs = effect.expiresAt ? new Date(effect.expiresAt).getTime() : Infinity;
    return startMs <= timeMs && timeMs < endMs;
  };

  const frozen = legCramps.some(isActive);
  if (frozen) return 0;

  const buffed = runnersHighs.some(isActive);
  const campfire = campfires.find((effect) => {
    const startMs = new Date(effect.startsAt).getTime();
    const freezeMs = (effect.metadata || {}).freezeMs || 0;
    const endMs = effect.expiresAt ? new Date(effect.expiresAt).getTime() : Infinity;
    return startMs <= timeMs && timeMs < endMs && timeMs >= startMs + freezeMs;
  });
  const campfireFrozen = campfires.some((effect) => {
    const startMs = new Date(effect.startsAt).getTime();
    const freezeMs = (effect.metadata || {}).freezeMs || 0;
    return startMs <= timeMs && timeMs < startMs + freezeMs;
  });
  if (campfireFrozen) return 0;

  const reversed = wrongTurns.some(isActive);
  const campfireMultiplier = campfire ? ((campfire.metadata || {}).multiplier || 1) : 1;
  let positiveMultiplier = Math.max(buffed ? 2 : 1, campfireMultiplier);

  if (reversed && positiveMultiplier > 1) return -positiveMultiplier;
  if (reversed) return -1;

  // Rainstorm: ADDITIVE -0.5x on positive accrual, matching the additive model
  // in computeEffectModifiers (1x → 0.5x, Runner's High 2x → 1.5x). Suspended
  // while frozen or reversed — both returned above before reaching here.
  const raining = rainstorms.some(isActive);
  if (raining) {
    const rainMeta = Number((rainstorms.find(isActive).metadata || {}).multiplier);
    const rainMultiplier =
      Number.isFinite(rainMeta) && rainMeta >= 0 && rainMeta <= 1 ? rainMeta : 0.5;
    positiveMultiplier = Math.max(0, positiveMultiplier - (1 - rainMultiplier));
  }

  if (positiveMultiplier !== 1) return positiveMultiplier;
  return 1;
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

  for (const effect of [
    ...effectGroups.legCramps,
    ...effectGroups.runnersHighs,
    ...effectGroups.wrongTurns,
    ...(effectGroups.campfires || []),
    ...(effectGroups.rainstorms || []),
  ]) {
    const startMs = Math.max(
      effectiveStart.getTime(),
      new Date(effect.startsAt).getTime()
    );
    const endMs = Math.min(
      now.getTime(),
      effect.expiresAt ? new Date(effect.expiresAt).getTime() : now.getTime()
    );
    if (endMs > startMs) {
      boundaries.add(startMs);
      boundaries.add(endMs);
    }
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
  stepTotals,
  raceActiveEffectModel,
  participantModel,
  powerupEventModel,
}) {
  if (typeof raceActiveEffectModel.findActiveForRace !== "function") {
    return;
  }
  const mines = (await raceActiveEffectModel.findActiveForRace(raceId)).filter(
    (effect) => effect.type === "TRAIL_MINE"
  );

  for (const mine of mines) {
    const metadata = mine.metadata || {};
    const ownerParticipantId = metadata.ownerParticipantId || mine.targetParticipantId;
    const positionSteps = metadata.positionSteps;
    const penaltyPercent = metadata.penaltyPercent;

    if (typeof positionSteps !== "number" || typeof penaltyPercent !== "number") {
      continue;
    }

    const candidates = stepTotals
      .filter(({ participant, totalSteps }) => {
        if (participant.id === ownerParticipantId) return false;
        const previousTotal = participant.totalSteps || 0;
        return previousTotal < positionSteps && totalSteps >= positionSteps;
      })
      .sort((a, b) => a.totalSteps - b.totalSteps);

    const victim = candidates[0];
    if (!victim) continue;

    const shield = await raceActiveEffectModel.findActiveByTypeForParticipant(
      victim.participant.id,
      "COMPRESSION_SOCKS"
    );
    const penalty = Math.round(victim.totalSteps * penaltyPercent);

    if (shield) {
      await raceActiveEffectModel.update(shield.id, { status: "BLOCKED" });
    } else if (penalty > 0) {
      await participantModel.subtractBonusSteps(victim.participant.id, penalty);
      victim.totalSteps = Math.max(0, victim.totalSteps - penalty);
    }

    await raceActiveEffectModel.update(mine.id, { status: "EXPIRED" });
    await powerupEventModel.create({
      raceId,
      actorUserId: mine.sourceUserId,
      eventType: shield ? "POWERUP_BLOCKED" : "POWERUP_USED",
      powerupType: "TRAIL_MINE",
      targetUserId: victim.participant.userId,
      description: shield
        ? `${victim.participant.user?.displayName || "A runner"} blocked a Trail Mine with Compression Socks!`
        : `${victim.participant.user?.displayName || "A runner"} triggered a Trail Mine and lost ${penalty.toLocaleString()} steps.`,
      metadata: {
        mineId: mine.id,
        penalty,
        penaltyPercent,
        positionSteps,
        blocked: Boolean(shield),
      },
    });
  }
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
  const completeRaceFn = dependencies.completeRace || completeRace;
  const now = dependencies.now || (() => new Date());

  return async function resolveRaceState({
    raceId,
    userId,
    timeZone = "UTC",
  } = {}) {
    let races = [];

    if (raceId) {
      const race = await raceModel.findById(raceId);
      if (race) races = [race];
    } else if (userId) {
      races = await raceModel.findActiveForUser(userId);
    }

    async function processRace(race) {
      if (race.status !== "ACTIVE" || !race.startedAt) {
        return null;
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
      const currentTime = now();

      // Fetch GlobalStepEvents overlapping [race start, now] once per race and
      // hand them to the SHARED math so this path matches getRaceProgress.
      // Read defensively: any failure or missing model => no boost.
      let globalEvents = [];
      try {
        globalEvents =
          (await globalStepEventModel.findActiveInRange(
            race.startedAt,
            currentTime
          )) || [];
      } catch {
        globalEvents = [];
      }

      // Per-participant compute+write phase. Each iteration reads only this
      // participant's step_samples/race_active_effects and writes only this
      // participant's row, so we can fan them out in parallel safely. Ordering
      // dependents (trailMines, placement, completeRace) run after.
      const stepTotals = new Array(acceptedParticipants.length);
      const finisherCandidates = new Array(acceptedParticipants.length);
      let previouslyFinished = 0;
      // Box-progress total for the requesting user (Leg Cramp + Wrong Turn
      // immune). Threaded to syncRacePowerupState so the roll gate ignores those
      // debuffs. Only the userId participant's value is needed (the caller syncs
      // for that user); stays null when resolveRaceState is called without userId.
      let userBoxEffectiveSteps = null;

      await Promise.all(
        acceptedParticipants.map(async (participant, index) => {
          if (participant.finishedAt) {
            // Read-only — increment outside Promise.all is unsafe, count later.
            stepTotals[index] = {
              participant,
              totalSteps:
                participant.finishTotalSteps ?? participant.totalSteps,
            };
            finisherCandidates[index] = null;
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
              stepsModel,
              stepSampleModel,
              now: currentTime,
            });

          const { total, legCramps, runnersHighs, wrongTurns, campfires, rainstorms } =
            await calculateCurrentTotal({
              raceId: race.id,
              racePowerupsEnabled: race.powerupsEnabled,
              participant,
              baseAdjusted,
              hasSampleData,
              raceActiveEffectModel,
              stepSampleModel,
              globalEvents,
              now: currentTime,
            });

          await participantModel.updateTotalSteps(participant.id, total);
          stepTotals[index] = { participant, totalSteps: total };

          // Capture the requesting user's RAW-walked-steps box total for the gate
          // (immune to every buff/debuff multiplier; never strands next_box). Box
          // progress buckets days in boxTz = raceTimeZone(race, "UTC") — the race's
          // canonical persisted tz if set, else the constant "UTC" (NEVER the
          // caller's tz, so it stays device-independent and can't clamp flat for
          // non-UTC users). This is the SAME rule the display path uses. For a
          // race with a canonical tz the leaderboard `baseAdjusted` just computed
          // above is already bucketed in boxTz, so reuse it — box == leaderboard by
          // construction; only a null-tz race recomputes in the fixed boxTz.
          if (userId && participant.userId === userId) {
            const boxTz = raceTimeZone(race, "UTC");
            let boxBaseAdjusted;
            if (raceTimeZone(race, timeZone) === boxTz) {
              boxBaseAdjusted = baseAdjusted;
            } else {
              ({ baseAdjusted: boxBaseAdjusted } = await calculateBaseAdjusted({
                participant,
                raceStartedAt: race.startedAt,
                timeZone: boxTz,
                stepsModel,
                stepSampleModel,
                now: currentTime,
              }));
            }
            userBoxEffectiveSteps = computeBoxEffectiveSteps({
              baseAdjusted: boxBaseAdjusted,
              bonusSteps: participant.bonusSteps || 0,
              maxBonusSteps: participant.maxBonusSteps || 0,
            });
          }

          // Target-based early finish only applies to goal races (targetSteps > 0).
          // Time-based races create with targetSteps = 0; since `0 >= 0`, an
          // unguarded check would mark every participant finished the instant the
          // race starts (and complete the race immediately). Time-based races must
          // finish ONLY when ends_at passes, via src/jobs/raceExpiry.js.
          //
          // The explicit `!race.timeBased` guard also covers seeded races that
          // KEEP a positive targetSteps as a display-only goal (e.g. Daily 10K /
          // Weekly 50K): when time_based = true they never finish on target,
          // regardless of targetSteps. Legacy target races (time_based = false,
          // the default) are unaffected and still finish on reaching the target.
          if (!race.timeBased && race.targetSteps > 0 && total >= race.targetSteps) {
            const snapshot = await determineFinishSnapshot({
              participant,
              currentTotal: total,
              targetSteps: race.targetSteps,
              effectiveStart,
              effectGroups: { legCramps, runnersHighs, wrongTurns, campfires, rainstorms },
              stepSampleModel,
              powerupEventModel,
              raceId: race.id,
              now: currentTime,
            });

            const finishTotalSteps = snapshot?.finishTotalSteps ?? total;
            const finishedAt = snapshot?.finishedAt ?? currentTime;

            await participantModel.markFinished(
              participant.id,
              finishedAt,
              finishTotalSteps
            );

            finisherCandidates[index] = {
              participant,
              totalSteps: finishTotalSteps,
              finishedAt,
            };
          } else {
            finisherCandidates[index] = null;
          }
        })
      );

      previouslyFinished = acceptedParticipants.filter((p) => p.finishedAt).length;
      const newFinishers = finisherCandidates.filter(Boolean);

      if (race.powerupsEnabled) {
        await triggerTrailMines({
          raceId: race.id,
          stepTotals,
          raceActiveEffectModel,
          participantModel,
          powerupEventModel,
        });
      }

      newFinishers.sort((a, b) => {
        const timeDiff = a.finishedAt - b.finishedAt;
        if (timeDiff !== 0) return timeDiff;
        return b.totalSteps - a.totalSteps;
      });

      for (let i = 0; i < newFinishers.length; i++) {
        const placement = previouslyFinished + i + 1;
        await participantModel.setPlacement(
          newFinishers[i].participant.id,
          placement
        );
      }

      const totalFinished = previouslyFinished + newFinishers.length;
      const finishThreshold = acceptedParticipants.length <= 3 ? 1 : 3;

      if (
        newFinishers.length > 0 &&
        totalFinished >= finishThreshold &&
        previouslyFinished < finishThreshold
      ) {
        const priorWinner = acceptedParticipants.find((p) => p.placement === 1);
        const winnerUserId = priorWinner
          ? priorWinner.userId
          : newFinishers[0].participant.userId;

        await completeRaceFn({
          raceId: race.id,
          winnerUserId,
          participantUserIds: acceptedParticipants.map((p) => p.userId),
        });
      }

      return {
        raceId: race.id,
        race, // expose so callers can hand it to syncRacePowerupState (avoids a duplicate findById)
        boxEffectiveSteps: userBoxEffectiveSteps, // Leg Cramp + Wrong Turn immune; null if no userId
        updatedParticipants: stepTotals.length,
        newFinishers: newFinishers.length,
      };
    }

    // Races are independent (no shared rows across race_participants), so we
    // process them in parallel as well.
    const processed = await Promise.all(races.map(processRace));
    return processed.filter(Boolean);
  };
}

const resolveRaceState = buildResolveRaceState();

module.exports = {
  POWERUP_EFFECT_TYPES,
  calculateBaseAdjusted,
  calculateSubsequentSteps,
  calculateCurrentTotal,
  triggerTrailMines,
  buildResolveRaceState,
  determineFinishSnapshot,
  resolveRaceState,
};
