const { Race } = require("../models/race");
const { RaceParticipant } = require("../models/raceParticipant");
const { Steps } = require("../models/steps");
const { StepSample } = require("../models/stepSample");
const { RacePowerup } = require("../models/racePowerup");
const { RaceActiveEffect } = require("../models/raceActiveEffect");
const { completeRace } = require("../commands/completeRace");
const { expireEffects } = require("../commands/expireEffects");
const { buildAccessoriesList } = require("../utils/shopCosmetics");
const {
  buildSyncRacePowerupState,
  syncRacePowerupState: defaultSyncRacePowerupState,
} = require("../services/racePowerupStateSync");
const { getTimeZoneParts, formatDateString, addDaysToDateString, parseDateString, zonedDateTimeToUtc } = require("../utils/week");

// Snapshot-based fallback for when StepSample data is unavailable
function computeEffectModifiersFallback(effects, rawTotal) {
  let frozenSteps = 0;
  let buffedSteps = 0;
  let reversedSteps = 0;

  for (const effect of effects) {
    const meta = effect.metadata || {};

    if (effect.type === "LEG_CRAMP") {
      const start = meta.stepsAtFreezeStart || 0;
      const end = effect.status === "EXPIRED" && meta.stepsAtExpiry !== undefined
        ? meta.stepsAtExpiry
        : rawTotal;
      frozenSteps += Math.max(0, end - start);
    }

    if (effect.type === "RUNNERS_HIGH") {
      const start = meta.stepsAtBuffStart || 0;
      const end = effect.status === "EXPIRED" && meta.stepsAtExpiry !== undefined
        ? meta.stepsAtExpiry
        : rawTotal;
      buffedSteps += Math.max(0, end - start);
    }

    if (effect.type === "WRONG_TURN") {
      const start = meta.stepsAtStart || 0;
      const end = effect.status === "EXPIRED" && meta.stepsAtExpiry !== undefined
        ? meta.stepsAtExpiry
        : rawTotal;
      reversedSteps += Math.max(0, end - start);
    }
  }

  return { frozenSteps, buffedSteps, reversedSteps };
}

async function computeEffectModifiers(effects, rawTotal, userId, stepSampleModel, hasSampleData = false) {
  let frozenSteps = 0;
  let buffedSteps = 0;
  let reversedSteps = 0;

  const legCramps = effects.filter((e) => e.type === "LEG_CRAMP");
  const runnersHighs = effects.filter((e) => e.type === "RUNNERS_HIGH");
  const wrongTurns = effects.filter((e) => e.type === "WRONG_TURN");
  const campfires = effects.filter((e) => e.type === "CAMPFIRE_REST");

  for (const effect of legCramps) {
    const windowStart = effect.startsAt;
    const windowEnd = effect.expiresAt || new Date();

    const sampleSteps = await stepSampleModel.sumStepsInWindow(userId, windowStart, windowEnd);
    if (sampleSteps > 0) {
      frozenSteps += sampleSteps;
    } else if (!hasSampleData) {
      // Only use snapshot fallback when user has no step sample data at all
      const meta = effect.metadata || {};
      const start = meta.stepsAtFreezeStart || 0;
      const end = effect.status === "EXPIRED" && meta.stepsAtExpiry !== undefined
        ? meta.stepsAtExpiry
        : rawTotal;
      frozenSteps += Math.max(0, end - start);
    }
  }

  for (const effect of runnersHighs) {
    const windowStart = effect.startsAt;
    const windowEnd = effect.expiresAt || new Date();

    const sampleSteps = await stepSampleModel.sumStepsInWindow(userId, windowStart, windowEnd);
    if (sampleSteps > 0) {
      buffedSteps += sampleSteps;
    } else if (!hasSampleData) {
      // Only use snapshot fallback when user has no step sample data at all
      const meta = effect.metadata || {};
      const start = meta.stepsAtBuffStart || 0;
      const end = effect.status === "EXPIRED" && meta.stepsAtExpiry !== undefined
        ? meta.stepsAtExpiry
        : rawTotal;
      buffedSteps += Math.max(0, end - start);
    }
  }

  for (const effect of campfires) {
    const meta = effect.metadata || {};
    const freezeMs = meta.freezeMs || 0;
    const multiplier = meta.multiplier || 1;
    const freezeStart = effect.startsAt;
    const freezeEnd = new Date(new Date(effect.startsAt).getTime() + freezeMs);
    const boostStart = freezeEnd;
    const boostEnd = effect.expiresAt || new Date();

    const frozenSampleSteps = await stepSampleModel.sumStepsInWindow(userId, freezeStart, freezeEnd);
    if (frozenSampleSteps > 0) {
      frozenSteps += frozenSampleSteps;
    } else if (!hasSampleData) {
      const start = meta.stepsAtRestStart || 0;
      const end = effect.status === "EXPIRED" && meta.stepsAtExpiry !== undefined
        ? meta.stepsAtExpiry
        : rawTotal;
      frozenSteps += Math.max(0, end - start);
    }

    const boostedSampleSteps = await stepSampleModel.sumStepsInWindow(userId, boostStart, boostEnd);
    if (boostedSampleSteps > 0) {
      buffedSteps += boostedSampleSteps * Math.max(0, multiplier - 1);
    }
  }

  // Subtract overlap: steps during both a freeze and a buff should be frozen, not buffed
  for (const cramp of legCramps) {
    const crampStart = cramp.startsAt.getTime();
    const crampEnd = (cramp.expiresAt || new Date()).getTime();

    for (const buff of runnersHighs) {
      const buffStart = buff.startsAt.getTime();
      const buffEnd = (buff.expiresAt || new Date()).getTime();

      const overlapStart = Math.max(crampStart, buffStart);
      const overlapEnd = Math.min(crampEnd, buffEnd);

      if (overlapStart < overlapEnd) {
        const overlapSteps = await stepSampleModel.sumStepsInWindow(
          userId, new Date(overlapStart), new Date(overlapEnd)
        );
        if (overlapSteps > 0) {
          buffedSteps -= overlapSteps;
        }
      }
    }
  }

  // Campfire Rest overlap with Runner's High:
  //   * Freeze phase: steps stay frozen — strip the RH buff for the overlap so
  //     RH cannot rescue frozen steps.
  //   * Boost phase: take the larger of the two multipliers, not both. Campfire
  //     contributes (multiplier - 1) and RH contributes 1; assuming campfire
  //     multiplier >= 2 (current upgrade range is 2.25–3.0), the RH +1 is the
  //     redundant one — strip it.
  // Matches raceStateResolution.js:238's max-not-sum semantics.
  for (const campfire of campfires) {
    const cfStart = campfire.startsAt.getTime();
    const cfFreezeMs = (campfire.metadata || {}).freezeMs || 0;
    const cfFreezeEnd = cfStart + cfFreezeMs;
    const cfBoostEnd = (campfire.expiresAt || new Date()).getTime();

    for (const buff of runnersHighs) {
      const buffStart = buff.startsAt.getTime();
      const buffEnd = (buff.expiresAt || new Date()).getTime();

      const overlapStart = Math.max(cfStart, buffStart);
      const overlapEnd = Math.min(cfBoostEnd, buffEnd);
      if (overlapStart >= overlapEnd) continue;

      const overlapSteps = await stepSampleModel.sumStepsInWindow(
        userId, new Date(overlapStart), new Date(overlapEnd)
      );
      if (overlapSteps > 0) {
        buffedSteps -= overlapSteps;
      }
    }
  }

  // Wrong Turn: steps during the effect are reversed (subtracted twice — once to undo, once to negate)
  for (const effect of wrongTurns) {
    const windowStart = effect.startsAt;
    const windowEnd = effect.expiresAt || new Date();

    const sampleSteps = await stepSampleModel.sumStepsInWindow(userId, windowStart, windowEnd);
    if (sampleSteps > 0) {
      reversedSteps += sampleSteps;
    }
  }

  // Wrong Turn + Runner's High overlap: steps are doubled AND negated
  for (const wt of wrongTurns) {
    const wtStart = wt.startsAt.getTime();
    const wtEnd = (wt.expiresAt || new Date()).getTime();

    for (const buff of runnersHighs) {
      const buffStart = buff.startsAt.getTime();
      const buffEnd = (buff.expiresAt || new Date()).getTime();

      const overlapStart = Math.max(wtStart, buffStart);
      const overlapEnd = Math.min(wtEnd, buffEnd);

      if (overlapStart < overlapEnd) {
        const overlapSteps = await stepSampleModel.sumStepsInWindow(
          userId, new Date(overlapStart), new Date(overlapEnd)
        );
        if (overlapSteps > 0) {
          // Remove buff credit and negate for doubled reversal
          buffedSteps -= 2 * overlapSteps;
        }
      }
    }
  }

  return { frozenSteps, buffedSteps, reversedSteps };
}

function buildGetRaceProgress(deps = {}) {
  const raceModel = deps.Race || Race;
  const participantModel = deps.RaceParticipant || RaceParticipant;
  const stepsModel = deps.Steps || Steps;
  const stepSampleModel = deps.StepSample || StepSample;
  const racePowerupModel = deps.RacePowerup || RacePowerup;
  const raceActiveEffectModel = deps.RaceActiveEffect || RaceActiveEffect;
  const completeRaceFn = deps.completeRace || completeRace;
  const expireEffectsFn = deps.expireEffects || expireEffects;
  const syncRacePowerupState =
    deps.syncRacePowerupState ||
    (Object.keys(deps).length > 0
      ? buildSyncRacePowerupState({
          Race: raceModel,
          RacePowerup: racePowerupModel,
          RaceParticipant: participantModel,
          rollPowerup: deps.rollPowerup,
        })
      : defaultSyncRacePowerupState);
  const now = deps.now || (() => new Date());

  return async function getRaceProgress(userId, raceId, timeZone) {
    const race = await raceModel.findById(raceId);
    if (!race) {
      const error = new Error("Race not found");
      error.statusCode = 404;
      throw error;
    }

    const myParticipant = race.participants.find((p) => p.userId === userId);
    if (!myParticipant) {
      const error = new Error("You are not a participant in this race");
      error.statusCode = 403;
      throw error;
    }

    if (race.status !== "ACTIVE") {
      const acceptedParticipants = race.participants.filter((p) => p.status === "ACCEPTED");
      return {
        raceId: race.id,
        status: race.status,
        endsAt: race.endsAt,
        maxDurationDays: race.maxDurationDays,
        participants: acceptedParticipants.map((p) => ({
          userId: p.userId,
          displayName: p.user.displayName,
          profilePhotoUrl: p.user.profilePhotoUrl,
          accessories: buildAccessoriesList(p.user),
          totalSteps: p.totalSteps,
          finishedAt: p.finishedAt,
        })),
      };
    }

    // Expire timed effects before calculating
    const participantStepsMap = {};
    const nowParts = getTimeZoneParts(now(), timeZone);
    const today = formatDateString(nowParts.year, nowParts.month, nowParts.day);
    const acceptedParticipants = race.participants.filter((p) => p.status === "ACCEPTED");

    // First pass: calculate raw step totals for expiry snapshots
    const raceStartedAt = race.startedAt;
    const rawStepTotals = await Promise.all(
      acceptedParticipants.map(async (p) => {
        const joinedAt = p.joinedAt || raceStartedAt;
        // Use the later of joinedAt and raceStartedAt (joinedAt could be pre-start for early accepters)
        const effectiveStart = joinedAt > raceStartedAt ? joinedAt : raceStartedAt;

        // Daily Steps queries use timezone-aware dates (steps are stored under local dates)
        const startParts = getTimeZoneParts(effectiveStart, timeZone);
        const startDate = formatDateString(startParts.year, startParts.month, startParts.day);
        const dayAfterStartDate = addDaysToDateString(startDate, 1);

        // StepSample window: from race start to end of the local start day
        // (midnight of the next day in the user's timezone, converted to UTC).
        // Using local midnight instead of UTC midnight ensures steps taken later
        // in the same local day are captured even when the race starts near UTC midnight.
        const dayAfterParsed = parseDateString(dayAfterStartDate);
        const startDayWindowEnd = zonedDateTimeToUtc({
          year: dayAfterParsed.year,
          month: dayAfterParsed.month,
          day: dayAfterParsed.day,
          hour: 0,
          minute: 0,
          second: 0,
        }, timeZone);

        // For the start day: try StepSample for precise post-start steps
        let startDaySteps = 0;
        const startDaySamples = await stepSampleModel.sumStepsInWindow(
          p.userId, effectiveStart, startDayWindowEnd
        );
        if (startDaySamples > 0) {
          startDaySteps = startDaySamples;
        }
        // The start day is a partial day, so only post-start samples are safe.
        // A later daily total sync can include pre-race steps that were not present
        // in the baseline snapshot at race start.

        // For days after the start day: prefer StepSamples, fall back to daily records
        let subsequentSteps = 0;
        if (dayAfterStartDate <= today) {
          const subsequentSamples = await stepSampleModel.sumStepsInWindow(
            p.userId, startDayWindowEnd, now()
          );
          if (subsequentSamples > 0) {
            subsequentSteps = subsequentSamples;
          } else {
            const laterSteps = await stepsModel.findByUserIdAndDateRange(p.userId, dayAfterStartDate, today);
            subsequentSteps = laterSteps.reduce((sum, s) => sum + s.steps, 0);
          }
        }

        const baseAdjusted = Math.max(0, startDaySteps + subsequentSteps);
        const hasSampleData = startDaySamples > 0;
        participantStepsMap[p.id] = baseAdjusted;
        return { participant: p, baseAdjusted, hasSampleData };
      })
    );

    await expireEffectsFn({ raceId, participantSteps: participantStepsMap });

    // Second pass: calculate powerup-adjusted totals
    const stepTotals = await Promise.all(
      rawStepTotals.map(async ({ participant, baseAdjusted, hasSampleData }) => {
        if (participant.finishedAt) {
          return {
            participant,
            totalSteps: participant.finishTotalSteps ?? participant.totalSteps,
          };
        }

        let total = baseAdjusted;

        if (race.powerupsEnabled) {
          // Fetch all Leg Cramp, Runner's High, and Wrong Turn effects (active + expired) for this participant
          const legCramps = await raceActiveEffectModel.findEffectsForRaceByType(raceId, participant.id, "LEG_CRAMP");
          const runnersHighs = await raceActiveEffectModel.findEffectsForRaceByType(raceId, participant.id, "RUNNERS_HIGH");
          const wrongTurns = await raceActiveEffectModel.findEffectsForRaceByType(raceId, participant.id, "WRONG_TURN");
          const campfires = await raceActiveEffectModel.findEffectsForRaceByType(raceId, participant.id, "CAMPFIRE_REST");

          const allEffects = [...legCramps, ...runnersHighs, ...wrongTurns, ...campfires];
          const { frozenSteps, buffedSteps, reversedSteps } = await computeEffectModifiers(allEffects, baseAdjusted, participant.userId, stepSampleModel, hasSampleData);

          total = Math.max(0, baseAdjusted - frozenSteps + buffedSteps - 2 * reversedSteps + (participant.bonusSteps || 0));
        }

        return { participant, totalSteps: total };
      })
    );

    // Update total steps for each active participant. Race completion is now
    // strictly time-based (handled by raceExpiry cron); no step-goal finish.
    for (const { participant, totalSteps } of stepTotals) {
      if (!participant.finishedAt) {
        await participantModel.updateTotalSteps(participant.id, totalSteps);
      }
    }

    // Roll powerups for the requesting user if they crossed a threshold
    let powerupData = null;

    if (race.powerupsEnabled && race.powerupStepInterval) {
      const myStepTotalEntry = stepTotals.find(
        ({ participant }) => participant.id === myParticipant.id
      );
      const myCurrentSteps =
        myStepTotalEntry?.totalSteps ??
        myParticipant.finishTotalSteps ??
        myParticipant.totalSteps ??
        0;
      const syncResult = await syncRacePowerupState({ raceId, userId });
      powerupData = {
        enabled: true,
        newMysteryBoxes: syncResult.newMysteryBoxes || [],
        newQueuedBoxes: syncResult.newQueuedBoxes || 0,
        powerupStepInterval: race.powerupStepInterval,
      };

      // Re-read participant to get current powerupSlots (may have changed via Fanny Pack expiry)
      const freshParticipant = await participantModel.findById(myParticipant.id);
      const mySlots = freshParticipant?.powerupSlots || 3;
      const nextBoxAtSteps =
        freshParticipant?.nextBoxAtSteps ?? myParticipant.nextBoxAtSteps ?? 0;

      powerupData.powerupSlots = mySlots;
      if (nextBoxAtSteps > 0) {
        // Use high-water mark of bonusSteps so pushbacks (Banana Peel/Red Card)
        // don't push the countdown back. Leg Cramp (frozenSteps) still does.
        const bonusNow = freshParticipant?.bonusSteps || 0;
        const maxBonus = freshParticipant?.maxBonusSteps || 0;
        const effectiveSteps =
          myCurrentSteps + Math.max(0, maxBonus - bonusNow);
        powerupData.stepsUntilNextPowerup = Math.max(
          nextBoxAtSteps - effectiveSteps,
          0
        );
      }

      // Unified inventory: both HELD and MYSTERY_BOX powerups in slots
      const slotPowerups = await racePowerupModel.findSlotPowerups(myParticipant.id);
      powerupData.inventory = slotPowerups.map((p) => ({
        id: p.id,
        type: p.type,
        rarity: p.rarity,
        status: p.status,
      }));

      // Queued box count for frontend indicator
      const queuedCount =
        syncResult.queuedBoxCount ??
        await racePowerupModel.countQueuedByParticipant(myParticipant.id);
      powerupData.queuedBoxCount = queuedCount;

      const myActiveEffects = await raceActiveEffectModel.findActiveForParticipant(myParticipant.id);
      const raceActiveEffects = await raceActiveEffectModel.findActiveForRace(raceId);

      powerupData.activeEffects = raceActiveEffects.map((e) => ({
        type: e.type,
        expiresAt: e.expiresAt,
        onSelf: e.targetUserId === userId,
        targetUserId: e.targetUserId,
        sourceUserId: e.sourceUserId,
      }));
    }

    // Build leaderboard with stealth mode and detour sign applied
    const stealthedUserIds = new Set();
    let viewerIsDetoured = false;
    if (race.powerupsEnabled) {
      const activeEffects = await raceActiveEffectModel.findActiveForRace(raceId);
      for (const e of activeEffects) {
        if (e.type === "STEALTH_MODE") {
          stealthedUserIds.add(e.targetUserId);
        }
        if (e.type === "DETOUR_SIGN" && e.targetUserId === userId) {
          viewerIsDetoured = true;
        }
      }
    }

    const leaderboard = stepTotals
      .map(({ participant, totalSteps }) => {
        // Detour Sign: viewer sees ALL participants as ???
        if (viewerIsDetoured) {
          return {
            userId: participant.userId,
            displayName: "???",
            profilePhotoUrl: null,
            accessories: [],
            totalSteps: null,
            finishedAt: participant.finishedAt,
            stealthed: false,
          };
        }
        const isStealthed = stealthedUserIds.has(participant.userId)
          && participant.userId !== userId
          && !participant.finishedAt;
        return {
          userId: participant.userId,
          displayName: isStealthed ? "???" : participant.user.displayName,
          profilePhotoUrl: isStealthed ? null : participant.user.profilePhotoUrl,
          accessories: isStealthed ? [] : buildAccessoriesList(participant.user),
          totalSteps: isStealthed ? null : totalSteps,
          finishedAt: participant.finishedAt,
          stealthed: isStealthed,
        };
      })
      .sort((a, b) => {
        // Stealthed users always appear at the top
        if (a.stealthed && !b.stealthed) return -1;
        if (!a.stealthed && b.stealthed) return 1;
        const aSteps = a.totalSteps ?? 0;
        const bSteps = b.totalSteps ?? 0;
        return bSteps - aSteps;
      });

    const updatedRace = await raceModel.findById(raceId);

    const result = {
      raceId: race.id,
      status: updatedRace.status,
      endsAt: race.endsAt,
      maxDurationDays: race.maxDurationDays,
      participants: leaderboard,
    };

    if (powerupData) {
      result.powerupData = powerupData;
    }

    return result;
  };
}

const getRaceProgress = buildGetRaceProgress();

module.exports = { getRaceProgress, buildGetRaceProgress, computeEffectModifiers };
