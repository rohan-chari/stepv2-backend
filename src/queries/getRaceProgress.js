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
const { calculateSubsequentSteps } = require("../utils/raceSteps");
const { GlobalStepEvent } = require("../models/globalStepEvent");
const { computeGlobalEventBoost } = require("../utils/globalStepEvent");
const { computeBoxEffectiveSteps } = require("../utils/boxSteps");

// Effect TYPES that are concealed self-advantages: visible ONLY to their owner,
// never to other racers. Filtered out of the activeEffects array server-side so
// that even older app binaries stop leaking these icons to opponents.
// NOTE: STEALTH_MODE and DETOUR_SIGN have their OWN separate hiding (leaderboard
// masking below) and are intentionally NOT in this set.
const HIDDEN_FROM_OPPONENTS = new Set([
  "COMPRESSION_SOCKS",
  "MIRROR",
  "LUCKY_HORSESHOE",
  "POCKET_WATCH",
  "FANNY_PACK",
  "TRAIL_MINE",
]);

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

// `globalContext` (optional, additive): { globalEvents: [...], now: Date }. When
// present, the EXTRA steps from any active GlobalStepEvent windows are returned
// as `globalBoostedSteps`, stacking multiplicatively with the per-participant
// timed multipliers below. Absent => globalBoostedSteps is 0 (legacy behavior).
async function computeEffectModifiers(effects, rawTotal, userId, stepSampleModel, hasSampleData = false, globalContext = null) {
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

  // Global step-multiplier event boost (additive, stacks multiplicatively with
  // the per-participant multipliers above). Computed over the SAME effect groups
  // so display and settlement agree exactly.
  let globalBoostedSteps = 0;
  if (globalContext && globalContext.globalEvents && globalContext.globalEvents.length > 0) {
    globalBoostedSteps = await computeGlobalEventBoost({
      globalEvents: globalContext.globalEvents,
      effectGroups: { legCramps, runnersHighs, wrongTurns, campfires },
      userId,
      stepSampleModel,
      now: globalContext.now,
    });
  }

  return { frozenSteps, buffedSteps, reversedSteps, globalBoostedSteps };
}

function buildGetRaceProgress(deps = {}) {
  const raceModel = deps.Race || Race;
  const participantModel = deps.RaceParticipant || RaceParticipant;
  const stepsModel = deps.Steps || Steps;
  const stepSampleModel = deps.StepSample || StepSample;
  const racePowerupModel = deps.RacePowerup || RacePowerup;
  const raceActiveEffectModel = deps.RaceActiveEffect || RaceActiveEffect;
  const globalStepEventModel = deps.GlobalStepEvent || GlobalStepEvent;
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
        targetSteps: race.targetSteps, // 1.1.4 compat
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

        // For days after the start day: per-day max(samples, daily). The race
        // must never count fewer steps than the authoritative daily total for
        // the covered period, and a stale daily row must never suppress larger
        // samples. SHARED with the settlement path (raceStateResolution.js) via
        // calculateSubsequentSteps so display and settlement stay identical.
        const subsequentSteps = await calculateSubsequentSteps({
          userId: p.userId,
          dayAfterStartDate,
          today,
          timeZone,
          stepsModel,
          stepSampleModel,
          now: now(),
        });

        const baseAdjusted = Math.max(0, startDaySteps + subsequentSteps);
        const hasSampleData = startDaySamples > 0;
        participantStepsMap[p.id] = baseAdjusted;
        return { participant: p, baseAdjusted, hasSampleData };
      })
    );

    await expireEffectsFn({ raceId, participantSteps: participantStepsMap });

    // Fetch GlobalStepEvents that overlap [raceStartedAt, now]. These are the
    // BeReal-style 2x windows that boost steps for ALL participants. Read
    // defensively: a missing/empty model just yields no boost. Passed into the
    // SHARED computeEffectModifiers so display matches settlement exactly.
    let globalEvents = [];
    try {
      globalEvents =
        (await globalStepEventModel.findActiveInRange(raceStartedAt, now())) ||
        [];
    } catch {
      globalEvents = [];
    }
    const globalContext = { globalEvents, now: now() };

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
        let legCramps = [];
        let runnersHighs = [];
        let wrongTurns = [];
        let campfires = [];

        if (race.powerupsEnabled) {
          // Fetch all Leg Cramp, Runner's High, and Wrong Turn effects (active + expired) for this participant
          legCramps = await raceActiveEffectModel.findEffectsForRaceByType(raceId, participant.id, "LEG_CRAMP");
          runnersHighs = await raceActiveEffectModel.findEffectsForRaceByType(raceId, participant.id, "RUNNERS_HIGH");
          wrongTurns = await raceActiveEffectModel.findEffectsForRaceByType(raceId, participant.id, "WRONG_TURN");
          campfires = await raceActiveEffectModel.findEffectsForRaceByType(raceId, participant.id, "CAMPFIRE_REST");
        }

        const allEffects = [...legCramps, ...runnersHighs, ...wrongTurns, ...campfires];
        const { frozenSteps, buffedSteps, reversedSteps, globalBoostedSteps } = await computeEffectModifiers(allEffects, baseAdjusted, participant.userId, stepSampleModel, hasSampleData, globalContext);

        total = Math.max(0, baseAdjusted - frozenSteps + buffedSteps - 2 * reversedSteps + (globalBoostedSteps || 0) + (race.powerupsEnabled ? (participant.bonusSteps || 0) : 0));

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
      // Box progress tracks RAW walked steps — immune to every buff/debuff
      // multiplier (the leaderboard total stays effect-sensitive). It is computed
      // with a FIXED reference timezone (UTC) so it is identical regardless of the
      // caller's device timezone; using the request tz made baseAdjusted (and thus
      // next_box's pace) tz-dependent, which left the countdown clamped flat at one
      // interval for non-UTC users. Lazy require breaks the getRaceProgress <->
      // raceStateResolution import cycle. (Steps lazily required for the same reason.)
      const { calculateBaseAdjusted } = require("../services/raceStateResolution");
      const { baseAdjusted: myBoxBaseAdjusted } = await calculateBaseAdjusted({
        participant: myParticipant,
        raceStartedAt: race.startedAt,
        timeZone: "UTC",
        stepsModel,
        stepSampleModel,
        now: now(),
      });
      const myBoxEffectiveSteps = computeBoxEffectiveSteps({
        baseAdjusted: myBoxBaseAdjusted,
        bonusSteps: myParticipant.bonusSteps || 0,
        maxBonusSteps: myParticipant.maxBonusSteps || 0,
      });
      const syncResult = await syncRacePowerupState({
        raceId,
        userId,
        boxEffectiveSteps: myBoxEffectiveSteps,
      });
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
        // Box countdown uses RAW walked steps (baseAdjusted) + the bonus
        // high-water — immune to every buff/debuff multiplier so it tracks real
        // walking only and matches the roll gate above exactly. Bonus-stealing
        // pushbacks stay protected via the high-water (max(bonus, maxBonus)). The
        // maxBoxProgressSteps anchor is deprecated and intentionally not read here.
        const bonusNow = freshParticipant?.bonusSteps || 0;
        const maxBonus = freshParticipant?.maxBonusSteps || 0;
        const effectiveSteps = computeBoxEffectiveSteps({
          baseAdjusted: myBoxBaseAdjusted,
          bonusSteps: bonusNow,
          maxBonusSteps: maxBonus,
        });
        // Clamp the countdown to at most one interval. nextBoxAtSteps ratchets up
        // off effective steps and a transient step-spike (later corrected) can
        // push it far above the player's real steps, which would otherwise show a
        // wildly-inflated "steps to next box" (e.g. ~12000 when the interval is
        // 2000). The countdown can never legitimately exceed one interval, so cap
        // it there regardless of how far nextBoxAtSteps has drifted.
        powerupData.stepsUntilNextPowerup = Math.max(
          0,
          Math.min(nextBoxAtSteps - effectiveSteps, race.powerupStepInterval)
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

      powerupData.activeEffects = raceActiveEffects
        // Keep an effect IF the viewer owns it (it's targeting them) OR its type
        // is not a concealed self-advantage. Otherwise drop opponents' hidden
        // buffs so they never leak to other racers, while the owner's own
        // ACTIVE EFFECTS panel (keyed on onSelf/targetUserId===me) keeps working.
        .filter(
          (e) =>
            e.targetUserId === userId || !HIDDEN_FROM_OPPONENTS.has(e.type)
        )
        .map((e) => ({
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
    // IMPOSTER display swaps: each entry swaps the DISPLAYED leaderboard slot of
    // two users (owner <-> metadata.swapWithUserId) for ALL viewers. Cosmetic
    // only — never read by the settlement path.
    const imposterSwaps = [];
    const nowTime = now();
    if (race.powerupsEnabled) {
      const activeEffects = await raceActiveEffectModel.findActiveForRace(raceId);
      for (const e of activeEffects) {
        if (e.type === "STEALTH_MODE") {
          stealthedUserIds.add(e.targetUserId);
        }
        if (e.type === "DETOUR_SIGN" && e.targetUserId === userId) {
          viewerIsDetoured = true;
        }
        if (e.type === "IMPOSTER") {
          // Defensive: skip effects already past expiry (findActiveForRace
          // should only return ACTIVE rows, but expiry-by-time may lag a tick).
          const notExpired =
            !e.expiresAt || new Date(e.expiresAt).getTime() > nowTime.getTime();
          const swapWithUserId = (e.metadata || {}).swapWithUserId;
          if (notExpired && e.targetUserId && swapWithUserId) {
            imposterSwaps.push({ a: e.targetUserId, b: swapWithUserId });
          }
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

    // Apply IMPOSTER display swaps: swap the two users' DISPLAYED leaderboard
    // SLOTS (array positions) while each row keeps its own name/steps. Applied
    // deterministically; a user already involved in an earlier swap, or a target
    // not present in the leaderboard, is skipped so swaps never throw or corrupt
    // the order. This is the ONLY place the swap is applied (display path only).
    if (imposterSwaps.length > 0) {
      const swappedUserIds = new Set();
      for (const { a, b } of imposterSwaps) {
        if (a === b) continue;
        if (swappedUserIds.has(a) || swappedUserIds.has(b)) continue;
        const ia = leaderboard.findIndex((p) => p.userId === a);
        const ib = leaderboard.findIndex((p) => p.userId === b);
        if (ia === -1 || ib === -1) continue;
        [leaderboard[ia], leaderboard[ib]] = [leaderboard[ib], leaderboard[ia]];
        swappedUserIds.add(a);
        swappedUserIds.add(b);
      }
    }

    const updatedRace = await raceModel.findById(raceId);

    const result = {
      raceId: race.id,
      status: updatedRace.status,
      endsAt: race.endsAt,
      maxDurationDays: race.maxDurationDays,
      targetSteps: race.targetSteps, // 1.1.4 compat
      participants: leaderboard,
    };

    if (powerupData) {
      result.powerupData = powerupData;
    }

    // Additive: surface the currently-active global step event (if any) so the
    // new app can show a "2x STEPS — ends in mm:ss" banner. Old apps ignore the
    // unknown field. Pick the event whose [startsAt, endsAt) contains `now`.
    const nowMsForEvent = now().getTime();
    const activeEvent = globalEvents.find((ev) => {
      const startMs = new Date(ev.startsAt).getTime();
      const endMs = new Date(ev.endsAt).getTime();
      return startMs <= nowMsForEvent && nowMsForEvent < endMs;
    });
    if (activeEvent) {
      result.globalEvent = {
        active: true,
        multiplier: Number(activeEvent.multiplier),
        endsAt: activeEvent.endsAt,
      };
    }

    return result;
  };
}

const getRaceProgress = buildGetRaceProgress();

module.exports = { getRaceProgress, buildGetRaceProgress, computeEffectModifiers };
