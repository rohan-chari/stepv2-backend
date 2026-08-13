const { Race } = require("../models/race");
const { RaceParticipant } = require("../models/raceParticipant");
const { Steps } = require("../../steps/models/steps");
const { StepSample } = require("../../steps/models/stepSample");
const { RaceActiveEffect } = require("../../powerups/models/raceActiveEffect");
const { RacePowerupEvent } = require("../../powerups/models/racePowerupEvent");
const { GlobalStepEvent } = require("../../steps/models/globalStepEvent");
const {
  computeEffectModifiers,
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
const { applyLeechTransfers } = require("../../powerups/leechTransfers");
const {
  collectRaceHitchhikeCopies,
  applyHitchhikeCopies,
} = require("../../powerups/hitchhikeCopies");
const { nextRawSteps } = require("../../powerups/rawPosition");
const {
  POWERUP_EFFECT_TYPES,
  SETTLEMENT_EFFECT_TYPES,
} = require("./raceScoringEffectTypes");
const {
  prefetchRaceScoringModels: defaultPrefetchRaceScoringModels,
} = require("./raceScoringPrefetch");

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
}) {
  if (typeof raceActiveEffectModel.findActiveForRace !== "function") {
    return;
  }
  const mines = (await raceActiveEffectModel.findActiveForRace(raceId)).filter(
    (effect) => effect.type === "TRAIL_MINE"
  );

  const isTeamRace = race ? race.isTeamRace === true : false;

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
  const prefetchRaceScoringModels =
    dependencies.prefetchRaceScoringModels || defaultPrefetchRaceScoringModels;
  const logger = dependencies.logger || console;
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

  // `userIds` (C0, spec §5a item 2) is ADDITIVE to the long-standing `userId`
  // argument: the race-keyed worker coalesces many uploaders into one resolve,
  // so it needs box-progress totals for EVERY user in the claimed job's
  // processing snapshot, not just the last one. Callers that pass only `userId`
  // are byte-for-byte unaffected — the returned `boxEffectiveSteps` still holds
  // that user's value.
  return async function resolveRaceState({
    raceId,
    userId,
    userIds = null,
    timeZone = "UTC",
  } = {}) {
    const boxUserIds = new Set(
      (Array.isArray(userIds) ? userIds : []).filter(Boolean)
    );
    if (userId) boxUserIds.add(userId);
    let races = [];

    if (raceId) {
      const race = typeof raceModel.findForResolution === "function"
        ? await raceModel.findForResolution(raceId)
        : await raceModel.findById(raceId);
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
      let prefetched = null;
      try {
        prefetched = await prefetchRaceScoringModels({
          races: [race],
          now: currentTime,
          stepsModel,
          stepSampleModel,
          raceActiveEffectModel,
        });
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
      const scoringEffectModel =
        prefetched?.raceActiveEffectModel || raceActiveEffectModel;

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
      // participant's row, so we can fan them out in parallel safely. The one
      // ordering dependent (trailMines) runs after.
      const stepTotals = new Array(acceptedParticipants.length);
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
      const preLeech = new Array(acceptedParticipants.length);
      await Promise.all(
        acceptedParticipants.map(async (participant, index) => {
          // TR-601: forfeited team-race members are FROZEN at the total the
          // forfeit command snapshotted — never recomputed here (their timed
          // effects expire naturally but the frozen number stands).
          if (participant.forfeitedAt) {
            preLeech[index] = {
              participant,
              frozen: true,
              totalSteps: participant.totalSteps || 0,
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

          const { total, leechTransfers } =
            await calculateCurrentTotal({
              raceId: race.id,
              racePowerupsEnabled: race.powerupsEnabled,
              participant,
              baseAdjusted,
              hasSampleData,
              raceActiveEffectModel: scoringEffectModel,
              stepSampleModel: scoringStepSampleModel,
              globalEvents,
              now: currentTime,
            });

          baseAdjustedByParticipantId[participant.id] = baseAdjusted;
          preLeech[index] = {
            participant,
            frozen: false,
            preLeechTotal: total,
            leechTransfers,
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
      );

      // Phase A2 — HITCHHIKE (§7.3). Identical to the display path's insertion in
      // getRaceProgress: ONE bulk query for every link in the race, folded into
      // the CASTER's pre-leech total BEFORE the leech resolution so copied steps
      // are drainable. Adding it here but not there (or vice versa) is the
      // live-vs-settlement divergence §7.3 warns about — it would surface as the
      // score changing at race end. The parity guard in
      // test/queries/hitchhikeScoring.test.js fails if the two drift.
      const hitchhikeCopies = race.powerupsEnabled
        ? await collectRaceHitchhikeCopies({
            raceId: race.id,
            raceEndsAt: race.endsAt,
            participants: race.participants,
            raceActiveEffectModel: scoringEffectModel,
            stepSampleModel: scoringStepSampleModel,
            now: currentTime,
            globalEvents,
          })
        : [];

      // Phase B: resolve all leeches race-wide against real victim availability
      // (zero-sum, deterministic), then persist each active participant's FINAL
      // total. Frozen participants keep their stored total and are never written.
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
        )
      );

      for (let index = 0; index < preLeech.length; index++) {
        const e = preLeech[index];
        if (e.frozen) {
          stepTotals[index] = { participant: e.participant, totalSteps: e.totalSteps };
          continue;
        }
        const finalTotal = leechFinals.get(e.participant.id) ?? e.preLeechTotal;
        // `rawSteps` rides the same write (2026-08-09): the RAW walked total
        // this participant was just scored from, high-watered against what is
        // already stored so a downward re-sync can't move their drop-odds
        // position backwards. Frozen rows never reach here (they `continue`
        // above), so a finished player's raw_steps stays frozen with their
        // total. Under the prod configuration this write is CAPTURED, not
        // executed — the v2 worker replays it inside its fence.
        await participantModel.updateStepTotals(e.participant.id, {
          totalSteps: finalTotal,
          rawSteps: nextRawSteps(
            e.participant.rawSteps,
            baseAdjustedByParticipantId[e.participant.id]
          ),
        });
        stepTotals[index] = { participant: e.participant, totalSteps: finalTotal };
      }

      if (race.powerupsEnabled) {
        await triggerTrailMines({
          raceId: race.id,
          race,
          stepTotals,
          raceActiveEffectModel: scoringEffectModel,
          participantModel,
          powerupEventModel,
        });
      }

      return {
        raceId: race.id,
        race, // expose so callers can hand it to syncRacePowerupState (avoids a duplicate findById)
        boxEffectiveSteps: userBoxEffectiveSteps, // Leg Cramp + Wrong Turn immune; null if no userId
        // Additive (C0): the same figure for every requested user. Existing
        // callers destructure only what they read, so this is inert for them.
        boxEffectiveStepsByUser: Object.fromEntries(boxEffectiveStepsByUser),
        // C3: participantId -> RAW walked steps, for the worker-side expireEffects.
        baseAdjustedByParticipantId,
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
  triggerTrailMines,
  buildResolveRaceState,
  determineFinishSnapshot,
  resolveRaceState,
};
