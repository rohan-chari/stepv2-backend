const { Race } = require("../models/race");
const { RaceParticipant } = require("../models/raceParticipant");
const { Steps } = require("../../steps/models/steps");
const { StepSample } = require("../../steps/models/stepSample");
const { RacePowerup } = require("../../powerups/models/racePowerup");
const { RaceActiveEffect } = require("../../powerups/models/raceActiveEffect");
const { completeRace } = require("../commands/completeRace");
const { expireEffects } = require("../../powerups/commands/expireEffects");
const { characterPresentation } = require("../../cosmetics");
const { placementsByUserId } = require("../placementOrder");
const {
  clampOffsetLimit,
} = require("../../../shared/pagination/clampOffsetLimit");
const {
  buildSyncRacePowerupState,
  syncRacePowerupState: defaultSyncRacePowerupState,
} = require("../services/racePowerupStateSync");
const { getTimeZoneParts, formatDateString, addDaysToDateString, parseDateString, zonedDateTimeToUtc } = require("../../../shared/time/week");
const { balanceConfig } = require("../../economy/balanceConfig");
const { adsBoxRerollEnabled } = require("../../economy/adRewards");
const {
  rarityOddsForPosition,
  typeOddsForPosition,
  buildRollContext,
  RARITY_ORDER,
} = require("../../powerups/powerupOdds");
const { rawPositionFor, nextRawSteps } = require("../../powerups/rawPosition");
const { calculateSubsequentSteps } = require("../raceSteps");
const {
  calculateBaseAdjusted,
  calculateCurrentTotal,
} = require("../services/raceStateResolution");
const { GlobalStepEvent } = require("../../steps/models/globalStepEvent");
const { computeGlobalEventBoost } = require("../../steps/globalStepEvent");
const { eventsForUser } = require("../../steps/services/globalStepEventEntitlement");
const { computeBoxEffectiveSteps } = require("../../powerups/boxSteps");
const { raceTimeZone } = require("../raceTimeZone");
// Canonical team H2H block — shared with the list/browser/home surfaces so all
// of them emit an identical shape (TR-401/806/809).
const { buildTeamsBlock } = require("../teamRaces");
const { collectRaceIllusions } = require("../services/raceIllusions");
const {
  imposterEnabled: defaultImposterEnabled,
} = require("../../powerups/constants/powerupGating");
const { roundLabel } = require("../../tournaments/constants/tournaments");
const { isTournamentParticipant } = require("../../tournaments/services/tournamentAccess");
const { canReadRacePreview } = require("../services/canReadRacePreview");
const {
  computeLeechEarnedTransfer,
  applyLeechTransfers,
} = require("../../powerups/leechTransfers");
const {
  collectRaceHitchhikeCopies,
  applyHitchhikeCopies,
} = require("../../powerups/hitchhikeCopies");
const { computeEffectModifiers, signedMultiplierForEffects } = require("../services/effectiveStepScoring");
const {
  evaluateHighMultiplierAlert,
} = require("../services/highMultiplierAlert");
// C3 (spec §5 Phase D). Everything below is INERT unless `redisStandingsEnabled`
// is on AND `REDIS_URL` is set — see the `standingsCacheEnabled()` gate.
const redisCache = require("../../../shared/cache/redisCache");
const defaultSnapshotStore = require("../services/raceProgressSnapshot");
const {
  recentBoxMints: defaultRecentBoxMints,
} = require("../services/recentBoxMints");
const { appSettings: defaultAppSettings } = require("../../../shared/config/appSettings");
const {
  enqueueRaceResolution: defaultEnqueueRaceResolution,
} = require("../services/enqueueRaceResolution");
// Batch 2026-08-10b item 2 — C4 read-through for `discardCapRemaining`. Falls
// through to Postgres whenever Redis or its flag is unavailable; the field is
// never gated on the cache existing.
const discardCapCache = require("../../powerups/services/discardCapCache");
const {
  prefetchRaceScoringModels: defaultPrefetchRaceScoringModels,
} = require("../services/raceScoringPrefetch");
const {
  computeRaceState: defaultComputeRaceState,
} = require("../services/computeRaceState");
const {
  raceResolutionDisplayArtifact: defaultDisplayArtifactStore,
  computeArtifactReuseDeadline,
} = require("../services/raceResolutionDisplayArtifact");
const {
  buildRaceResolutionInputFingerprint: defaultBuildInputFingerprint,
} = require("../services/raceResolutionInputFingerprint");
const { isStrictFlagEnabled } = require("../../../shared/config/isStrictFlagEnabled");
const userPresentationCache = require("../../social/services/userPresentationCache");
const defaultPageProjection = require("../services/raceProgressPageProjection");

// The (releaseChannel × supportsCharacters × supportsRemoteAssets) combinations
// `characterPresentation` can produce. Closed set: `resolveReleaseChannel` only
// ever yields "prod" or "testflight". Precomputing all eight keeps raw `equippedAccessories` rows (and
// their Date columns) out of the snapshot while staying byte-identical to what
// the uncached response would have emitted.
const PRESENTATION_CHANNELS = ["prod", "testflight"];

function presentationKey(channel, supportsCharacters, supportsRemoteAssets) {
  return `${channel}:${supportsCharacters ? 1 : 0}:${supportsRemoteAssets ? 1 : 0}`;
}

function buildPresentationVariants(user) {
  if (!user) return {};
  const out = {};
  for (const channel of PRESENTATION_CHANNELS) {
    for (const supportsCharacters of [false, true]) {
      for (const supportsRemoteAssets of [false, true]) {
        out[
          presentationKey(channel, supportsCharacters, supportsRemoteAssets)
        ] = characterPresentation(
          user,
          supportsCharacters,
          channel,
          supportsRemoteAssets
        );
      }
    }
  }
  return out;
}

function readPresentation(
  entry,
  channel,
  supportsCharacters,
  supportsRemoteAssets = false
) {
  const variants = entry.presentation || {};
  return (
    variants[presentationKey(channel, supportsCharacters, supportsRemoteAssets)] ||
    variants[presentationKey("prod", supportsCharacters, supportsRemoteAssets)] || {
      animal: null,
      accessories: [],
    }
  );
}

// Additive tournament-matchup context for a matchup race's progress payload
// (null on ordinary races). The frontend banner reads these defensively.
function tournamentFields(race) {
  if (!race || !race.tournamentId) {
    return {
      tournamentId: null,
      tournamentRound: null,
      tournamentRoundLabel: null,
      tournamentName: null,
    };
  }
  return {
    tournamentId: race.tournamentId,
    tournamentRound: race.tournamentRound ?? null,
    tournamentRoundLabel: race.tournament
      ? roundLabel(race.tournament.bracketSize, race.tournamentRound)
      : null,
    tournamentName: race.tournament?.name ?? null,
  };
}

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
  // Wave 5 concealed self-advantages (§4.5). BOUNTY is deliberately NOT here —
  // its public visibility is the mechanic.
  "DECOY",
  "UMBRELLA",
  "PIGGY_BANK",
]);

// Snapshot-based fallback for when StepSample data is unavailable. NOTE: this
// helper is currently unreferenced (dead code) — the second pass always uses the
// sample-driven computeEffectModifiers below. Leech is a cross-participant
// transfer that cannot be expressed from a single participant's snapshot, so it
// returns no leech transfers here; the real scorer handles it.
function buildDropOdds({
  race,
  userId,
  stepTotals,
  persistedParticipants,
  snapshot,
  supportsPowerups5 = false,
}) {
  const { version, config } = snapshot;

  // The odds POSITION comes from RAW WALKED steps on the PERSISTED participant
  // rows (2026-08-09, docs/box-raw-steps-position-and-option-h-requirements.md)
  // — the same helper and the same source openMysteryBox / rerollMysteryBox
  // rank on, so the quoted odds and the actual roll cannot disagree.
  //
  // Deliberately NOT the live replay's or the snapshot's `baseAdjusted`: those
  // can lead the persisted column by a replay cycle, which would make the
  // quoted odds disagree with the real roll in exactly the manipulated case
  // this feature exists to fix (the invariant at powerupOdds.js:161-163).
  const { position, totalParticipants, myTeamValid } = rawPositionFor({
    participants: persistedParticipants,
    race,
    userId,
  });
  if (race.isTeamRace && !myTeamValid) return null;
  if (position === 0 || totalParticipants === 0) return null;

  const rarityRow = rarityOddsForPosition(position, totalParticipants, config);
  const rarity = {};
  RARITY_ORDER.forEach((name, i) => {
    rarity[name] = rarityRow[i];
  });

  // Position-aware drop context, from the SAME shared helper openMysteryBox uses
  // and from the SAME true step totals (never the illusion-masked board), so a
  // stealthed or masked opponent cannot change what you are eligible to roll and
  // the quoted byType cannot drift from the actual roll.
  //
  // Only `byType` moves — `rarity` above is untouched, and must stay untouched:
  // the shipped odds sheet hides itself entirely if that block stops summing
  // to 1.0 ± 0.01.
  const myTotalSteps =
    stepTotals.find(({ participant }) => participant.userId === userId)?.totalSteps ?? 0;
  const ctx = buildRollContext({
    stepTotals: stepTotals.map(({ totalSteps }) => totalSteps || 0),
    myTotalSteps,
    position,
    totalParticipants,
    // 2026-07-26 §5.6 — the SAME two hard gates the roll applies. This is not
    // optional: byType is keyed by raw powerup type, so an ungated odds sheet
    // would advertise a type this client/race can never actually roll. The roll
    // and the disclosure read one function with one ctx precisely so they cannot
    // disagree; drop either field here and the sheet starts lying.
    isTeamRace: race.isTeamRace === true,
    supportsPowerups5,
  });

  const byType = typeOddsForPosition(position, totalParticipants, config, ctx);

  return {
    configVersion: version,
    position,
    totalParticipants,
    rarity,
    // Omitted entirely (not null) when empty, so clients can presence-check.
    ...(Object.keys(byType).length > 0 ? { byType } : {}),
  };
}

function buildGetRaceProgress(deps = {}) {
  // Injected dependencies are used by the pure scoring fixtures. They do not
  // represent the production request path and intentionally retain the replay
  // seam so those fixtures can exercise live scoring math without requiring a
  // persisted snapshot model.
  const hasInjectedDependencies = Object.keys(deps).length > 0;
  // The integration suite contains legacy Redis-off contract tests that use
  // the production singleton but intentionally do not boot the worker. Keep
  // those deterministic fixtures on the old replay seam; the deployed runtime
  // is explicitly NODE_ENV=production. Production requests always use the
  // persisted fallback when the shared snapshot path is unavailable.
  const legacyReplayForTests = process.env.NODE_ENV !== "production";
  const participantEventQueryEnabled =
    Object.keys(deps).length === 0 || deps.GlobalStepEvent != null;
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
  const isTournamentParticipantFn =
    deps.isTournamentParticipant || isTournamentParticipant;
  // Imposter kill switch (Item 3): when disabled, existing held/active Imposters
  // stop swapping leaderboard rows for everyone at once, regardless of app
  // version. Injectable for tests; defaults to the env reader.
  const imposterEnabledFn = deps.imposterEnabled || defaultImposterEnabled;

  // ── C3 wiring (spec §5 Phase D). All of it is inert unless the flag is on. ──
  const snapshotStore = deps.raceProgressSnapshot || defaultSnapshotStore;
  const pageProjection = deps.raceProgressPageProjection || defaultPageProjection;
  const settings = deps.appSettings || defaultAppSettings;
  const enqueueRaceResolutionFn =
    deps.enqueueRaceResolution || defaultEnqueueRaceResolution;
  const recentBoxMintsStore = deps.recentBoxMints || defaultRecentBoxMints;
  const prefetchRaceScoringModels =
    deps.prefetchRaceScoringModels || defaultPrefetchRaceScoringModels;
  const logger = deps.logger || console;
  const computeRaceState = deps.computeRaceState || defaultComputeRaceState;
  const displayArtifactStore =
    deps.raceResolutionDisplayArtifact || defaultDisplayArtifactStore;
  const buildInputFingerprint =
    deps.buildRaceResolutionInputFingerprint || defaultBuildInputFingerprint;
  const presentationCache =
    deps.userPresentationCache || userPresentationCache;

  async function displayArtifactReuseEnabled() {
    if (deps.raceResolutionDisplayArtifactReuseV1Enabled != null) {
      return deps.raceResolutionDisplayArtifactReuseV1Enabled === true;
    }
    return isStrictFlagEnabled(settings, "raceResolutionDisplayArtifactReuseV1Enabled");
  }

  // The gate for EVERY Phase-D behavior change. Two conditions, both required:
  //   * `REDIS_URL` is set — with it unset the wrapper is fully inert (Phase A
  //     contract) and there is no snapshot to serve, so the endpoint keeps its
  //     legacy replay+write-back. This is also what keeps the ~20 unit-test
  //     files that build this query with fake models from ever touching
  //     `app_settings` (they run with no Redis and no database).
  //   * the `redisStandingsEnabled` app setting is true.
  // "Redis configured but UNREACHABLE" is deliberately still flag-ON: that is
  // spec test 5e, where every request must take the cheap persisted read and the
  // replay must not run.
  async function standingsCacheEnabled() {
    if (deps.redisStandingsEnabled != null) {
      return deps.redisStandingsEnabled === true;
    }
    if (!redisCache.isEnabled()) return false;
    try {
      return (await settings.getFlag("redisStandingsEnabled")) === true;
    } catch {
      return false;
    }
  }

  // ── THE SHARED REPLAY (viewer-free) ────────────────────────────────────────
  //
  // Every participant's effect-adjusted total, the honest placements, the
  // per-participant multiplier, the team block, the active-effect rows and the
  // global-event banner. Nothing in here reads the requester's identity.
  //
  // `persist` is the ONLY difference between the two flag states, and it gates
  // exactly the three side effects Phase D step 8 moves to the worker:
  //   expireEffects, the `updateTotalSteps` write-back, and the
  //   high-multiplier-alert claim.
  // With the flag ON all three are false and this function issues ZERO writes.
  async function computeSharedState({ race, raceId, scoringTimeZone, persist }) {
    const participantStepsMap = {};
    const requestNow = now();
    const raceEndMs = race.endsAt == null
      ? Number.POSITIVE_INFINITY
      : new Date(race.endsAt).getTime();
    const deadlinePassed = Number.isFinite(raceEndMs) && raceEndMs <= requestNow.getTime();
    const scoringNow = new Date(deadlinePassed ? raceEndMs : requestNow.getTime());
    const nowParts = getTimeZoneParts(scoringNow, scoringTimeZone);
    const today = formatDateString(nowParts.year, nowParts.month, nowParts.day);
    const acceptedParticipants = race.participants.filter(
      (p) => p.status === "ACCEPTED"
    );
    let prefetched = null;
    try {
      prefetched = await prefetchRaceScoringModels({
        races: [race],
        now: scoringNow,
        stepsModel,
        stepSampleModel,
        raceActiveEffectModel,
      });
    } catch (error) {
      logger.error(
        `[RACE_PROGRESS] scoring prefetch failed (race ${raceId}):`,
        error
      );
    }
    const scoringStepsModel = prefetched?.stepsModel || stepsModel;
    const scoringStepSampleModel =
      prefetched?.stepSampleModel || stepSampleModel;
    const scoringEffectModel =
      prefetched?.raceActiveEffectModel || raceActiveEffectModel;

    // First pass: raw step totals (baseAdjusted) for expiry snapshots + boxes.
    const raceStartedAt = race.startedAt;
    const rawStepTotals = await Promise.all(
      acceptedParticipants.map(async (p) => {
        const joinedAt = p.joinedAt || raceStartedAt;
        // Use the later of joinedAt and raceStartedAt (joinedAt could be pre-start for early accepters)
        const effectiveStart = joinedAt > raceStartedAt ? joinedAt : raceStartedAt;

        // Daily Steps queries use timezone-aware dates (steps are stored under local dates)
        const startParts = getTimeZoneParts(effectiveStart, scoringTimeZone);
        const startDate = formatDateString(startParts.year, startParts.month, startParts.day);
        const dayAfterStartDate = addDaysToDateString(startDate, 1);

        // StepSample window: from race start to end of the local start day
        // (midnight of the next day in the user's timezone, converted to UTC).
        const dayAfterParsed = parseDateString(dayAfterStartDate);
        const nextStartDayMidnight = zonedDateTimeToUtc({
          year: dayAfterParsed.year,
          month: dayAfterParsed.month,
          day: dayAfterParsed.day,
          hour: 0,
          minute: 0,
          second: 0,
        }, scoringTimeZone);
        // Once the race deadline has passed, keep the start-day slice inside
        // that deadline. An active race deliberately reads through midnight so
        // an open HealthKit bucket (future periodEnd, already-observed steps)
        // is counted in full rather than linearly truncated at request time.
        const settledCutoff = deadlinePassed ? raceEndMs : Number.POSITIVE_INFINITY;
        const startDayWindowEnd = new Date(Math.min(
          nextStartDayMidnight.getTime(),
          settledCutoff
        ));

        // Start-of-local-day instant in the scoring tz. When the race begins
        // EXACTLY at local midnight the start day is a FULL day, so the
        // authoritative daily total is safe as a fallback.
        const startOfStartDay = zonedDateTimeToUtc({
          year: startParts.year,
          month: startParts.month,
          day: startParts.day,
          hour: 0,
          minute: 0,
          second: 0,
        }, scoringTimeZone);
        const startsAtLocalMidnight =
          effectiveStart.getTime() === startOfStartDay.getTime();

        let startDaySteps = 0;
        const startDaySamples = await scoringStepSampleModel.sumStepsInWindow(
          p.userId, effectiveStart, startDayWindowEnd
        );
        const startDayIsCompleteAtCutoff =
          !deadlinePassed || nextStartDayMidnight.getTime() <= raceEndMs;
        if (startsAtLocalMidnight && startDayIsCompleteAtCutoff) {
          const startDayRow = await scoringStepsModel.findByUserIdAndDate(
            p.userId,
            startDate
          );
          startDaySteps = Math.max(startDaySamples, startDayRow?.steps ?? 0);
        } else if (startDaySamples > 0) {
          startDaySteps = startDaySamples;
        }

        // Per-day max(samples, daily) for days after the start day. SHARED with
        // the settlement path via calculateSubsequentSteps.
        const subsequentSteps = await calculateSubsequentSteps({
          userId: p.userId,
          dayAfterStartDate,
          today,
          timeZone: scoringTimeZone,
          stepsModel: scoringStepsModel,
          stepSampleModel: scoringStepSampleModel,
          now: scoringNow,
          allowPartialDayDaily: !deadlinePassed,
        });

        const baseAdjusted = Math.max(0, startDaySteps + subsequentSteps);
        let hasSampleData = startDaySamples > 0;
        if (
          !hasSampleData &&
          typeof scoringStepSampleModel.hasAnyInWindow === "function"
        ) {
          hasSampleData = await scoringStepSampleModel.hasAnyInWindow(
            p.userId,
            effectiveStart,
            scoringNow
          );
        }
        participantStepsMap[p.id] = baseAdjusted;
        return { participant: p, baseAdjusted, hasSampleData, effectiveStart };
      })
    );

    // Phase D step 8 — MOVED to the v2 worker's post-commit hook when the flag
    // is on (raceProgressSideEffects.runPostResolutionSideEffects).
    if (persist) {
      await expireEffectsFn({ raceId, participantSteps: participantStepsMap });
    }

    // GlobalStepEvents overlapping [raceStartedAt, now] — the 2x windows. Read
    // defensively: a missing/empty model just yields no boost.
    let globalEvents = [];
    let eventsByUserId = null;
    if (participantEventQueryEnabled &&
        typeof globalStepEventModel.findEligibleByRace === "function") {
      eventsByUserId = await globalStepEventModel.findEligibleByRace({
        raceId,
        userIds: acceptedParticipants.map((participant) => participant.userId),
        rangeStart: raceStartedAt,
        rangeEnd: scoringNow,
      });
      const seen = new Map();
      for (const participant of acceptedParticipants) {
        for (const event of eventsForUser(eventsByUserId, participant.userId)) {
          seen.set(`${event.entitlementId || event.id}:${participant.userId}`, event);
        }
      }
      globalEvents = [...seen.values()];
    } else {
      try {
        globalEvents =
          (await globalStepEventModel.findActiveInRange(raceStartedAt, scoringNow)) || [];
      } catch {
        globalEvents = [];
      }
      eventsByUserId = new Map(
        acceptedParticipants.map((participant) => [participant.userId, globalEvents])
      );
    }

    // Second pass, phase A: per-participant PRE-LEECH total + the leeches
    // targeting each participant.
    const preLeech = await Promise.all(
      rawStepTotals.map(async ({ participant, baseAdjusted, hasSampleData, effectiveStart }) => {
        // TR-601: forfeited members stay FROZEN at the forfeit snapshot.
        if (participant.forfeitedAt) {
          return {
            participant,
            frozen: true,
            totalSteps: participant.totalSteps || 0,
          };
        }
        if (participant.finishedAt) {
          return {
            participant,
            frozen: true,
            totalSteps: participant.finishTotalSteps ?? participant.totalSteps,
          };
        }

        let legCramps = [];
        let runnersHighs = [];
        let wrongTurns = [];
        let campfires = [];
        let rainstorms = [];
        let leeches = [];
        let wave5Effects = [];

        if (race.powerupsEnabled) {
          legCramps = await scoringEffectModel.findEffectsForRaceByType(raceId, participant.id, "LEG_CRAMP");
          legCramps.push(...await scoringEffectModel.findEffectsForRaceByType(raceId, participant.id, "QUICKSAND"));
          runnersHighs = await scoringEffectModel.findEffectsForRaceByType(raceId, participant.id, "RUNNERS_HIGH");
          wrongTurns = await scoringEffectModel.findEffectsForRaceByType(raceId, participant.id, "WRONG_TURN");
          campfires = await scoringEffectModel.findEffectsForRaceByType(raceId, participant.id, "CAMPFIRE_REST");
          rainstorms = await scoringEffectModel.findEffectsForRaceByType(raceId, participant.id, "RAINSTORM");
          leeches = await scoringEffectModel.findEffectsForRaceByType(raceId, participant.id, "LEECH");
          if (typeof scoringEffectModel.findEffectsForRaceByTypes === "function") {
            const w5 = await scoringEffectModel.findEffectsForRaceByTypes(
              raceId,
              participant.id,
              ["UPRISING", "RALLY_FLAG", "COIN_FLIP", "GHOST_PEPPER", "UMBRELLA"]
            );
            wave5Effects = [
              ...(w5.UPRISING || []), ...(w5.RALLY_FLAG || []), ...(w5.COIN_FLIP || []),
              ...(w5.GHOST_PEPPER || []), ...(w5.UMBRELLA || []),
            ];
          }
        }

        const allEffects = [...legCramps, ...runnersHighs, ...wrongTurns, ...campfires, ...rainstorms, ...leeches, ...wave5Effects];
        const participantEvents = eventsForUser(eventsByUserId, participant.userId);
        const globalContext = { globalEvents: participantEvents, now: scoringNow };
        const { frozenSteps, buffedSteps, reversedSteps, globalBoostedSteps, leechTransfers } = await computeEffectModifiers(allEffects, baseAdjusted, participant.userId, scoringStepSampleModel, hasSampleData, globalContext, scoringNow);

        const preLeechTotal = Math.max(0, baseAdjusted - frozenSteps + buffedSteps - 2 * reversedSteps + (globalBoostedSteps || 0) + (race.powerupsEnabled ? (participant.bonusSteps || 0) : 0));

        // §6a — the SIGNED effective multiplier right now.
        const currentMultiplierRaw = race.powerupsEnabled
          ? signedMultiplierForEffects(allEffects, scoringNow.getTime())
          : 1;

        return { participant, frozen: false, preLeechTotal, leechTransfers, currentMultiplierRaw };
      })
    );

    // Phase A2 — HITCHHIKE (§7.3). MUST run BEFORE applyLeechTransfers. The
    // SAME two lines appear in raceStateResolution.processRace and raceExpiry.
    const hitchhikeCopies = race.powerupsEnabled
      ? await collectRaceHitchhikeCopies({
          raceId,
          raceEndsAt: race.endsAt,
          participants: race.participants,
          raceActiveEffectModel: scoringEffectModel,
          stepSampleModel: scoringStepSampleModel,
          now: scoringNow,
          globalEvents,
          eventsByUserId,
        })
      : [];

    // Phase B: resolve every leech across the race against actual availability.
    const leechFinals = applyLeechTransfers(
      applyHitchhikeCopies(
        preLeech
          .filter((e) => !e.frozen)
          .map((e) => ({
            participantId: e.participant.id,
            userId: e.participant.userId,
            preLeechTotal: e.preLeechTotal,
            leechTransfers: e.leechTransfers,
          })),
        hitchhikeCopies
      )
    );

    const stepTotals = preLeech.map((e) => {
      if (e.frozen) {
        return { participant: e.participant, totalSteps: e.totalSteps };
      }
      return {
        participant: e.participant,
        totalSteps: leechFinals.get(e.participant.id) ?? e.preLeechTotal,
      };
    });

    // Phase D step 8 — THE M×N REQUEST-PATH WRITE-BACK. This loop is the writer
    // the 2026-08-07 incident traced back to: ~2,400 rows rewritten with no
    // mutual exclusion, once per poll, per viewer. With the flag on it does not
    // run at all; the race-keyed v2 worker persists the same numbers under its
    // fence, and the lock winner enqueues that job on snapshot expiry.
    if (persist) {
      for (const { participant, totalSteps } of stepTotals) {
        if (!participant.finishedAt && !participant.forfeitedAt) {
          // `rawSteps` rides the same write (2026-08-09): the RAW walked total
          // from this replay's first pass, high-watered against the stored
          // value. Frozen rows are skipped by the guard above, so a finished
          // player's raw_steps is never advanced.
          const nextRaw = nextRawSteps(
            participant.rawSteps,
            participantStepsMap[participant.id]
          );
          await participantModel.updateStepTotals(participant.id, {
            totalSteps,
            rawSteps: nextRaw,
          });
          // Heal the IN-MEMORY row too. `race` was loaded once at the top of
          // the request, and buildDropOdds ranks on these same objects — so
          // without this line the disclosure quotes a position derived from the
          // pre-write values and heals one poll late, which on a first-ever
          // resolve means quoting the totalSteps fallback for a request that
          // just persisted every raw_steps in the race.
          participant.rawSteps = nextRaw;
          snapshotStore.__bump("writeBacks");
        }
      }
    }

    // ONE read of the race's ACTIVE effects. The legacy path read this twice
    // (once for the effects panel, once for the illusions); both consumers are
    // now viewer-overlay code reading this single array.
    const raceActiveEffects = race.powerupsEnabled
      ? await scoringEffectModel.findActiveForRace(raceId)
      : [];

    // §6a — per-participant CURRENT MULTIPLIER, with any active global 2x event
    // folded into the MAGNITUDE (sign preserved).
    const nowTime = scoringNow;
    const nowMsForMult = nowTime.getTime();
    const multiplierByParticipantId = new Map();
    for (const e of preLeech) {
      const raw = e.frozen ? 1 : (e.currentMultiplierRaw ?? 1);
      const activeEventForMult = eventsForUser(eventsByUserId, e.participant.userId)
        .find((ev) => {
          const s = new Date(ev.startsAt).getTime();
          const end = new Date(ev.endsAt).getTime();
          return s <= nowMsForMult && nowMsForMult < end && Number(ev.multiplier) > 1;
        });
      const eventMult = activeEventForMult ? Number(activeEventForMult.multiplier) : 1;
      multiplierByParticipantId.set(e.participant.id, raw * eventMult);
    }

    // §6b — high-multiplier alert. Phase D step 8 moves this CLAIM (it writes
    // race_participants.highMultiplierNotifiedAt) to the worker.
    if (persist && race.powerupsEnabled) {
      const activeForAlert = acceptedParticipants.filter(
        (p) => !p.finishedAt && !p.forfeitedAt
      );
      for (const p of acceptedParticipants) {
        try {
          await evaluateHighMultiplierAlert({
            participant: p,
            currentMultiplier: multiplierByParticipantId.get(p.id) ?? 1,
            race,
            otherParticipants: activeForAlert,
            now: () => scoringNow,
          });
        } catch (err) {
          console.error("high-multiplier alert eval failed:", err);
        }
      }
    }

    // Items 12/16 — ONE server-authoritative placement, from the HONEST live
    // totals (before Stealth masking and before the Imposter slot swap).
    const placementByUserId = placementsByUserId(
      stepTotals.map(({ participant, totalSteps }) => ({
        userId: participant.userId,
        totalSteps,
        finishedAt: participant.finishedAt,
        placement: participant.placement,
        joinedAt: participant.joinedAt,
      }))
    );

    const updatedRace = race._leanProgressProjection &&
        typeof raceModel.findProgressStatus === "function"
      ? await raceModel.findProgressStatus(raceId)
      : await raceModel.findById(raceId);
    const raceForStatus = updatedRace || race;

    // Team H2H block (TR-401), computed from TRUE totals before any display
    // illusion — always honest (TR-658).
    const teams = race.isTeamRace ? buildTeamsBlock(race, stepTotals) : null;

    // Additive: the currently-active global step event, if any.
    const nowMsForEvent = scoringNow.getTime();
    const activeEvent = globalEvents.find((ev) => {
      const startMs = new Date(ev.startsAt).getTime();
      const endMs = new Date(ev.endsAt).getTime();
      return startMs <= nowMsForEvent && nowMsForEvent < endMs;
    });
    const globalEvent = activeEvent
      ? {
          active: true,
          multiplier: Number(activeEvent.multiplier),
          endsAt: activeEvent.endsAt,
        }
      : null;

    return snapshotStore.buildSnapshot({
      race: {
        raceId: race.id,
        status: raceForStatus.status,
        endsAt: race.endsAt,
        maxDurationDays: race.maxDurationDays,
        targetSteps: race.targetSteps, // 1.1.4 compat
        isTeamRace: race.isTeamRace,
        teamSize: race.teamSize ?? null,
        winnerTeam: raceForStatus.winnerTeam ?? null,
        powerupsEnabled: race.powerupsEnabled,
        powerupStepInterval: race.powerupStepInterval,
        ...tournamentFields(race),
      },
      participants: stepTotals.map(({ participant, totalSteps }) => ({
        participantId: participant.id,
        userId: participant.userId,
        ...(participant.user && !race._leanProgressProjection
          ? {
              displayName: participant.user.displayName,
              profilePhotoUrl: participant.user.profilePhotoUrl,
              presentation: buildPresentationVariants(participant.user),
            }
          : {}),
        totalSteps,
        finishedAt: participant.finishedAt,
        forfeitedAt: participant.forfeitedAt ?? null,
        team: participant.team ?? null,
        placement: placementByUserId.get(participant.userId) ?? null,
        currentMultiplier: multiplierByParticipantId.get(participant.id) ?? 1,
        baseAdjusted: participantStepsMap[participant.id] ?? null,
      })),
      teams,
      globalEvent,
      activeEffects: raceActiveEffects,
      scoringTimeZone,
      asOf: nowTime,
      source: persist ? "replay-legacy" : "replay",
      schemaVersion: race._leanProgressProjection
        ? snapshotStore.LEAN_SCHEMA_VERSION
        : snapshotStore.SCHEMA_VERSION,
    });
  }

  function buildSnapshotFromResolution({ result, race: displayRace = null, scoringTimeZone }) {
    const race = displayRace || result?.race;
    const capture = result?.displayCapture;
    if (!race || !capture || !Array.isArray(capture.stepTotals)) return null;
    const participantById = new Map(
      (race.participants || []).map((participant) => [participant.id, participant])
    );
    const stepTotals = capture.stepTotals.map((row) => ({
      participant: participantById.get(row.participantId),
      totalSteps: row.totalSteps,
    }));
    if (stepTotals.some((row) => !row.participant)) return null;
    const placementByUserId = placementsByUserId(
      stepTotals.map(({ participant, totalSteps }) => ({
        userId: participant.userId,
        totalSteps,
        finishedAt: participant.finishedAt,
        placement: participant.placement,
        joinedAt: participant.joinedAt,
      }))
    );
    const asOf = new Date(capture.asOf);
    if (Number.isNaN(asOf.getTime())) return null;
    return snapshotStore.buildSnapshot({
      race: {
        raceId: race.id,
        status: race.status,
        endsAt: race.endsAt,
        maxDurationDays: race.maxDurationDays,
        targetSteps: race.targetSteps,
        isTeamRace: race.isTeamRace,
        teamSize: race.teamSize ?? null,
        winnerTeam: race.winnerTeam ?? null,
        powerupsEnabled: race.powerupsEnabled,
        powerupStepInterval: race.powerupStepInterval,
        ...tournamentFields(race),
      },
      participants: stepTotals.map(({ participant, totalSteps }) => ({
        participantId: participant.id,
        userId: participant.userId,
        ...(participant.user
          ? {
              displayName: participant.user.displayName,
              profilePhotoUrl: participant.user.profilePhotoUrl,
              presentation: buildPresentationVariants(participant.user),
            }
          : {}),
        totalSteps,
        finishedAt: participant.finishedAt,
        forfeitedAt: participant.forfeitedAt ?? null,
        team: participant.team ?? null,
        placement: placementByUserId.get(participant.userId) ?? null,
        currentMultiplier:
          capture.currentMultiplierByParticipantId?.[participant.id] ?? 1,
        baseAdjusted: result.baseAdjustedByParticipantId?.[participant.id] ?? null,
      })),
      teams: race.isTeamRace ? buildTeamsBlock(race, stepTotals) : null,
      activeEffects: capture.activeEffects || [],
      scoringTimeZone,
      asOf,
      source: "replay-artifact",
      schemaVersion: race._leanProgressProjection
        ? snapshotStore.LEAN_SCHEMA_VERSION
        : snapshotStore.SCHEMA_VERSION,
    });
  }

  // ── THE CHEAP PERSISTED-COLUMNS READ (viewer-free) ─────────────────────────
  //
  // Phase D step 7's pinned fallback: what a lock LOSER on a true cold start
  // serves, and what EVERY request serves while Redis is down. It runs the
  // `getRaceDetails` shape — persisted `totalSteps` + the shared placement
  // comparator — plus one indexed read of the race's active effects so the
  // effects panel and the multiplier badge do not blank out. It NEVER runs the
  // replay. Cold-start fallbacks are not published; the worker may publish this
  // shape immediately after committing the authoritative totals.
  async function loadPersistedState({
    race,
    raceId,
    scoringTimeZone,
    baseAdjustedByParticipantId = null,
  }) {
    snapshotStore.__bump("persistedFallbacks");
    const accepted = race.participants.filter((p) => p.status === "ACCEPTED");
    const leanSnapshot = race._leanProgressProjection === true;
    let presentations = new Map();
    if (!leanSnapshot) {
      try {
        presentations = await presentationCache.getMany(
          accepted.map((participant) => participant.userId),
          true,
        );
      } catch (error) {
        // Persisted totals remain useful if the optional presentation cache is
        // unavailable. Legacy full reads still carry `participant.user`, while
        // lean reads safely fall back to a presentation-free row.
        logger.warn?.("Race progress presentation cache unavailable", {
          error: error?.message,
        });
      }
    }
    const raceActiveEffects = race.powerupsEnabled
      ? await raceActiveEffectModel.findActiveForRace(raceId)
      : [];

    const nowTime = now();
    const nowMs = nowTime.getTime();
    let eventsByUserId;
    if (typeof globalStepEventModel.findEligibleByRace === "function") {
      eventsByUserId = await globalStepEventModel.findEligibleByRace({
        raceId,
        userIds: accepted.map((participant) => participant.userId),
        rangeStart: race.startedAt,
        rangeEnd: nowTime,
      });
    } else {
      let legacyEvents = [];
      try {
        legacyEvents =
          (await globalStepEventModel.findActiveInRange(race.startedAt, nowTime)) || [];
      } catch {
        legacyEvents = [];
      }
      eventsByUserId = new Map(
        accepted.map((participant) => [participant.userId, legacyEvents])
      );
    }

    const effectsByParticipant = new Map();
    for (const effect of raceActiveEffects) {
      const key = effect.targetParticipantId;
      if (!key) continue;
      if (!effectsByParticipant.has(key)) effectsByParticipant.set(key, []);
      effectsByParticipant.get(key).push(effect);
    }

    const totalFor = (p) =>
      p.finishedAt ? (p.finishTotalSteps ?? p.totalSteps) : (p.totalSteps || 0);

    const placementByUserId = placementsByUserId(
      accepted.map((p) => ({
        userId: p.userId,
        totalSteps: totalFor(p),
        finishedAt: p.finishedAt,
        placement: p.placement,
        joinedAt: p.joinedAt,
      }))
    );

    const participants = accepted.map((p) => {
      const frozen = Boolean(p.finishedAt || p.forfeitedAt);
      const raw =
        race.powerupsEnabled && !frozen
          ? signedMultiplierForEffects(effectsByParticipant.get(p.id) || [], nowMs)
          : 1;
      const activeEvent = eventsForUser(eventsByUserId, p.userId).find((event) => {
        const startMs = new Date(event.startsAt).getTime();
        const endMs = new Date(event.endsAt).getTime();
        return startMs <= nowMs && nowMs < endMs && Number(event.multiplier) > 1;
      });
      const eventMult = activeEvent ? Number(activeEvent.multiplier) : 1;
      const presentation = leanSnapshot
        ? null
        : presentations.get(p.userId) || p.user || null;
      return {
        participantId: p.id,
        userId: p.userId,
        ...(presentation
          ? {
              displayName: presentation.displayName,
              profilePhotoUrl: presentation.profilePhotoUrl,
              presentation: buildPresentationVariants(presentation),
            }
          : {}),
        totalSteps: totalFor(p),
        finishedAt: p.finishedAt,
        forfeitedAt: p.forfeitedAt ?? null,
        team: p.team ?? null,
        placement: placementByUserId.get(p.userId) ?? null,
        currentMultiplier: raw * eventMult,
        // A worker publish threads through the raw totals it just computed.
        // Cold-start/Redis-outage fallbacks omit the map and retain the
        // requester-only calculation in the overlay.
        baseAdjusted:
          baseAdjustedByParticipantId?.[p.id] ?? null,
      };
    });

    return snapshotStore.buildSnapshot({
      race: {
        raceId: race.id,
        status: race.status,
        endsAt: race.endsAt,
        maxDurationDays: race.maxDurationDays,
        targetSteps: race.targetSteps,
        isTeamRace: race.isTeamRace,
        teamSize: race.teamSize ?? null,
        winnerTeam: race.winnerTeam ?? null,
        powerupsEnabled: race.powerupsEnabled,
        powerupStepInterval: race.powerupStepInterval,
        ...tournamentFields(race),
      },
      participants,
      teams: race.isTeamRace
        ? buildTeamsBlock(
            race,
            accepted.map((p) => ({ participant: p, totalSteps: totalFor(p) }))
          )
        : null,
      activeEffects: raceActiveEffects,
      scoringTimeZone,
      asOf: nowTime,
      source: "persisted",
      schemaVersion: race._leanProgressProjection
        ? snapshotStore.LEAN_SCHEMA_VERSION
        : snapshotStore.SCHEMA_VERSION,
    });
  }

  // ── THE VIEWER OVERLAY ─────────────────────────────────────────────────────
  //
  // Everything the requester's identity or their client's capabilities decide,
  // computed per request from the shared snapshot plus the requester's OWN
  // cheap reads: `myPlacement`/`myPlacementHidden`, the whole `powerupData`
  // block (box countdown, inventory, queued count, upgrade ladders,
  // `dropOdds`), the per-viewer effect filter and capability downcasts, the
  // Stealth/Detour/Imposter illusions, and `characterPresentation`.
  async function buildViewerResponse({
    snapshot,
    race,
    raceId,
    userId,
    myParticipant,
    scoringTimeZone,
    supportsCharacters,
    supportsRemoteAssets,
    supportsPowerups3,
    supportsPowerups4,
    supportsPowerups5,
    releaseChannel,
    supportsAds = false,
    // Batch 2026-08-10b item 2: the viewer's STORED timezone (falling back to
    // the request zone at the route). Used ONLY for the discard-cap day
    // boundary; the leaderboard's scoring tz is `scoringTimeZone` above.
    userTimeZone = null,
    syncPowerups,
    // Participants pagination (docs/race-participants-pagination-requirements.md
    // §5.2). Threaded from the outer query, NOT read from an outer scope: the
    // slicing block below runs inside THIS function, so these must arrive as
    // parameters or every progress request throws a ReferenceError.
    participantsView = null,
    participantsOffset = 0,
    participantsLimit = 10,
    hydratePresentation = false,
    requesterEntry = null,
    projectionPagination = null,
    projectionMetadata = null,
  }) {
    const snapRace = snapshot.race || {};
    const entries = snapshot.participants || [];
    const raceActiveEffects = snapshot.activeEffects || [];
    const nowTime = now();
    const viewerEntries = requesterEntry &&
      !entries.some((entry) => entry.userId === requesterEntry.userId)
      ? [...entries, requesterEntry]
      : entries;

    // Redis-disabled progress serves the cheap persisted roster snapshot. The
    // persisted total can lag a just-used powerup (bonusSteps/penalties are
    // participant-local), so refresh only this viewer's score before building
    // the response. This preserves powerup correctness without replaying or
    // writing the entire race on every poll.
    if (
      legacyReplayForTests &&
      (!snapshot.source ||
        snapshot.source === "persisted" ||
        snapshot.source === "worker-persisted")
    ) {
      const viewerEntry = viewerEntries.find((entry) => entry.userId === userId);
      if (viewerEntry && myParticipant && !myParticipant.finishedAt) {
        try {
          const scoringParticipant =
            syncPowerups && typeof participantModel.findById === "function"
              ? (await participantModel.findById(myParticipant.id)) || myParticipant
              : myParticipant;
          const { baseAdjusted, hasSampleData } = await calculateBaseAdjusted({
            participant: scoringParticipant,
            raceStartedAt: race.startedAt,
            timeZone: scoringTimeZone,
            stepsModel,
            stepSampleModel: StepSample,
            now: nowTime,
            raceEndsAt: race.endsAt,
          });
          let globalEvents = [];
          if (typeof globalStepEventModel.findEligibleByRace === "function") {
            const eventsByUser = await globalStepEventModel.findEligibleByRace({
              raceId,
              userIds: [userId],
              rangeStart: race.startedAt,
              rangeEnd: nowTime,
            });
            globalEvents = eventsForUser(eventsByUser, userId);
          }
          const scored = await calculateCurrentTotal({
            raceId,
            racePowerupsEnabled: race.powerupsEnabled,
            participant: scoringParticipant,
            baseAdjusted,
            hasSampleData,
            raceActiveEffectModel,
            stepSampleModel: StepSample,
            globalEvents,
            now: nowTime,
          });
          if (Number.isFinite(scored.total)) {
            viewerEntry.totalSteps = scored.total;
            viewerEntry.currentMultiplier = scored.currentMultiplierRaw ?? 1;
            const placementByUserId = placementsByUserId(
              entries.map((entry) => ({
                userId: entry.userId,
                totalSteps: entry.totalSteps,
                finishedAt: entry.finishedAt,
                placement: entry.placement,
                joinedAt: entry.joinedAt,
              }))
            );
            viewerEntry.placement = placementByUserId.get(userId) ?? null;
          }
        } catch (error) {
          // Persisted roster data remains a safe fallback if this optional
          // requester-only refresh cannot complete.
          console.warn("Race progress viewer score refresh failed:", error?.message);
        }
      }
    }

    // Build leaderboard with stealth mode and detour sign applied, from the
    // SAME shared collector the tournament bracket uses so the two surfaces
    // mask identically.
    let stealthedUserIds = new Set();
    let viewerIsDetoured = false;
    let imposterSwaps = [];
    if (snapRace.powerupsEnabled) {
      ({ stealthedUserIds, viewerIsDetoured, imposterSwaps } =
        collectRaceIllusions(raceActiveEffects, userId, nowTime.getTime()));
    }

    // Roll powerups for the requesting user if they crossed a threshold.
    // Spectators (no myParticipant) never earn powerups — skip the whole block.
    let powerupData = null;
    let balanceConfigSnapshot = null;
    if (myParticipant && snapRace.powerupsEnabled && snapRace.powerupStepInterval) {
      // Box progress tracks RAW walked steps — immune to every buff/debuff
      // multiplier. It buckets calendar days in boxTz = raceTimeZone(race,
      // "UTC"): the race's canonical persisted tz if set, else the literal
      // constant "UTC" — never the request tz. When boxTz === the leaderboard's
      // scoring tz we REUSE the snapshot's `baseAdjusted` so box and leaderboard
      // agree by construction. A non-ACCEPTED requester, a null-tz race, and the
      // persisted fallback (which has no baseAdjusted) all recompute here for
      // THIS USER ONLY. Lazy require breaks the getRaceProgress <->
      // raceStateResolution import cycle.
      const boxTz = raceTimeZone(race, "UTC");
      const myEntry = viewerEntries.find((e) => e.participantId === myParticipant.id);
      const reusedLeaderboardBase = myEntry ? myEntry.baseAdjusted : null;
      let myBoxBaseAdjusted;
      if (scoringTimeZone === boxTz && reusedLeaderboardBase != null) {
        myBoxBaseAdjusted = reusedLeaderboardBase;
      } else {
        const { calculateBaseAdjusted } = require("../services/raceStateResolution");
        ({ baseAdjusted: myBoxBaseAdjusted } = await calculateBaseAdjusted({
          participant: myParticipant,
          raceStartedAt: race.startedAt,
          timeZone: boxTz,
          stepsModel,
          stepSampleModel,
          now: now(),
          raceEndsAt: race.endsAt,
        }));
      }
      const myBoxEffectiveSteps = computeBoxEffectiveSteps({
        baseAdjusted: myBoxBaseAdjusted,
        bonusSteps: myParticipant.bonusSteps || 0,
        maxBonusSteps: myParticipant.maxBonusSteps || 0,
      });
      // Phase D step 8: the box-gate sync WRITES race_participants
      // (nextBoxAtSteps, maxBonusSteps) and mints RacePowerup rows, so with the
      // flag on it belongs to the worker, which runs it for every triggering
      // user of the claimed job — and the progress poll's enqueue makes THIS
      // viewer one of them.
      //
      // The mint delta (`newMysteryBoxes`/`newQueuedBoxes`) is what drives the
      // client's "You earned a mystery box!" toast, so it cannot simply go
      // empty (spec v9 item 2). The worker records each mint under the user's
      // recent-mints key; here we CONSUME this race's entries atomically and
      // fold them back into the same fields, in the same shape. Only this
      // race's entries are taken — another race's pending toast survives for
      // its own next poll.
      const syncResult = syncPowerups
        ? await syncRacePowerupState({
            raceId,
            userId,
            boxEffectiveSteps: myBoxEffectiveSteps,
          })
        : await recentBoxMintsStore.consume({ userId, raceId });
      // One config read per request; the same snapshot feeds the upgrade
      // ladders below and the dropOdds block further down.
      balanceConfigSnapshot = await balanceConfig.getSnapshot();
      powerupData = {
        enabled: true,
        newMysteryBoxes: syncResult.newMysteryBoxes || [],
        newQueuedBoxes: syncResult.newQueuedBoxes || 0,
        powerupStepInterval: snapRace.powerupStepInterval,
        upgradeCosts: {
          byRarity: balanceConfigSnapshot.config.upgradeCosts.byRarity,
          byType: balanceConfigSnapshot.config.upgradeCosts.byType,
        },
        // Batch 2026-08-08 item 1: what a discard pays, by rarity. Served from
        // the same balance config the award itself reads, so the confirm dialog
        // can never quote a price the server won't honour — the client prefers
        // this over its bundled map and falls back to that map when the key is
        // absent (older backend). Additive; old clients ignore it.
        discardPrices: balanceConfigSnapshot.config.discardPrices,
        rarityByType: balanceConfigSnapshot.config.rarityByType,
        capabilities: {
          pocketWatchTargetEffect: true,
        },
      };

      // Batch 2026-08-08 item 11 — advertise the rewarded-ad box reroll. The
      // key is OMITTED (not `false`) unless BOTH the server kill switch is on
      // AND this request came from a build that can show a rewarded ad, so the
      // payload every frozen binary already parses is byte-identical.
      if (supportsAds && adsBoxRerollEnabled()) {
        powerupData.boxReroll = true;
        // Batch 2026-08-10b item 1 — REROLL ALL after OPEN ALL. Advertised
        // under the SAME condition as `boxReroll` (one kill switch governs both
        // endpoints), and OMITTED rather than `false` when off, so the payload
        // every frozen binary already parses stays byte-identical.
        powerupData.boxRerollBatch = true;
      }

      // Re-read participant to get current powerupSlots (may have changed via Fanny Pack expiry)
      const freshParticipant = await participantModel.findById(myParticipant.id);
      const mySlots = freshParticipant?.powerupSlots || 3;
      const nextBoxAtSteps =
        freshParticipant?.nextBoxAtSteps ?? myParticipant.nextBoxAtSteps ?? 0;

      powerupData.powerupSlots = mySlots;
      if (nextBoxAtSteps > 0) {
        const bonusNow = freshParticipant?.bonusSteps || 0;
        const maxBonus = freshParticipant?.maxBonusSteps || 0;
        const effectiveSteps = computeBoxEffectiveSteps({
          baseAdjusted: myBoxBaseAdjusted,
          bonusSteps: bonusNow,
          maxBonusSteps: maxBonus,
        });
        // Clamp the countdown to at most one interval.
        powerupData.stepsUntilNextPowerup = Math.max(
          0,
          Math.min(nextBoxAtSteps - effectiveSteps, snapRace.powerupStepInterval)
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

      // Batch 2026-08-10b item 2 — how much of the DAILY DISCARD COIN CAP is
      // left, so the confirm dialog can quote the clamped amount BEFORE the
      // first discard of a screen visit (it previously only learned the cap
      // FROM a discard response, and so lied exactly once per visit).
      //
      // Placed HERE, not next to `discardPrices` above (architect R5):
      // `slotPowerups` is the only thing that can answer "does this viewer hold
      // a discardable row?", and it is not read until just above. Computing it
      // earlier would either cost a second query or silently drop the guard.
      //
      // Overlay-only (architect S3): this is a PER-VIEWER value and must never
      // enter the shared C3 `v1:race:progress` snapshot or its pinned field
      // allowlist. Structurally safe today because `powerupData` is built
      // entirely in the overlay — stated so it stays that way.
      //
      // Additive: an integer >= 0, ignored by every frozen client.
      if (powerupData.inventory.some((p) => p.status === "HELD")) {
        try {
          powerupData.discardCapRemaining = await discardCapCache.getDiscardCapRemaining({
            userId,
            // Same precedence as the discard route: the STORED zone first, so
            // the cap can't be widened by spoofing X-Timezone.
            timezone: userTimeZone || null,
            appSettings: settings,
          });
        } catch {
          // A display hint must never fail the whole progress poll. Omitted on
          // error, which degrades to today's (occasionally wrong) dialog.
        }
      }

      // Queued box count for frontend indicator
      const queuedCount =
        syncResult.queuedBoxCount ??
        await racePowerupModel.countQueuedByParticipant(myParticipant.id);
      powerupData.queuedBoxCount = queuedCount;

      // (The legacy path also issued a `findActiveForParticipant` here whose
      // result was never read — dead weight on the hottest endpoint. Dropped;
      // the per-viewer filter below works off the shared race-wide array.)
      powerupData.activeEffects = raceActiveEffects
        // Keep an effect IF the viewer owns it OR its type is not a concealed
        // self-advantage.
        .filter(
          (e) =>
            e.targetUserId === userId || !HIDDEN_FROM_OPPONENTS.has(e.type)
        )
        // §9.3: withhold HITCHHIKE from clients that don't advertise powerups3.
        .filter((e) => supportsPowerups3 || e.type !== "HITCHHIKE")
        // §4.5: wave-5 types a non-powerups5 client cannot render are WITHHELD.
        .filter(
          (e) =>
            supportsPowerups5 ||
            ![
              "GHOST_PEPPER", "COIN_FLIP", "DECOY", "UMBRELLA",
              "PIGGY_BANK", "DRILL_SERGEANT", "BOUNTY",
            ].includes(e.type)
        )
        .map(async (e) => {
          let type = e.type;
          if (type === "QUICKSAND" && !supportsPowerups4) type = "LEG_CRAMP";
          if (!supportsPowerups5) {
            if (type === "POWER_OUTAGE") type = "SIGNAL_JAMMER";
            else if (type === "UPRISING" || type === "RALLY_FLAG") type = "RUNNERS_HIGH";
          }
          const entry = {
            id: e.id,
            type,
            expiresAt: e.expiresAt,
            onSelf: e.targetUserId === userId,
            targetUserId: e.targetUserId,
            sourceUserId: e.sourceUserId,
          };
          // Piggy Bank live "banked so far" counter (display-only, owner-only).
          // At most one extra query, for the requester's OWN effect — a viewer
          // overlay read, never cached.
          if (e.type === "PIGGY_BANK" && e.targetUserId === userId) {
            const meta = e.metadata || {};
            const stepsPerCoin = Number(meta.stepsPerCoin) || 300;
            const coinCap = Number.isFinite(Number(meta.coinCap)) ? Number(meta.coinCap) : 80;
            if (coinCap > 0 && stepsPerCoin > 0) {
              try {
                const start = new Date(e.startsAt);
                const expiry = e.expiresAt ? new Date(e.expiresAt) : now();
                const nowMs = now().getTime();
                const end = expiry.getTime() < nowMs ? expiry : new Date(nowMs);
                if (end.getTime() > start.getTime()) {
                  const windowSteps = await StepSample.sumStepsInWindow(e.targetUserId, start, end);
                  entry.piggyBank = {
                    bankedCoins: Math.min(
                      Math.floor(Math.max(0, windowSteps) / stepsPerCoin),
                      coinCap
                    ),
                    coinCap,
                    windowSteps: Math.round(Math.max(0, windowSteps)),
                  };
                }
              } catch (err) {
                console.error("Piggy Bank live counter failed:", err);
              }
            }
          }
          return entry;
        });
      powerupData.activeEffects = await Promise.all(powerupData.activeEffects);
    }

    const leaderboard = entries
      .map((entry) => {
        // §6a — a masked row must NOT leak the player's multiplier.
        const rawCurrentMultiplier = entry.currentMultiplier ?? 1;
        // Detour Sign: viewer sees ALL participants as ???
        if (viewerIsDetoured) {
          return {
            userId: entry.userId,
            displayName: "???",
            profilePhotoUrl: null,
            accessories: [],
            animal: null,
            totalSteps: null,
            finishedAt: entry.finishedAt,
            // The picker uses this shared mask marker to exclude hidden
            // opponents from offensive target pools as well as the board.
            stealthed: true,
            currentMultiplier: null,
            // Detour Sign masks every total, so it must mask every rank too.
            placement: null,
            // Team identity is structural (column grouping), never masked.
            team: entry.team ?? null,
            forfeitedAt: entry.forfeitedAt ?? null,
          };
        }
        const isStealthed = stealthedUserIds.has(entry.userId)
          && entry.userId !== userId
          && !entry.finishedAt;
        return {
          userId: entry.userId,
          displayName: isStealthed ? "???" : entry.displayName,
          profilePhotoUrl: isStealthed ? null : entry.profilePhotoUrl,
          ...(isStealthed
            ? { accessories: [], animal: null }
            : readPresentation(
                entry,
                releaseChannel,
                supportsCharacters,
                supportsRemoteAssets
              )),
          totalSteps: isStealthed ? null : entry.totalSteps,
          finishedAt: entry.finishedAt,
          stealthed: isStealthed,
          // A stealthed rival's steps are nulled, so their rank must be too.
          placement: isStealthed ? null : (entry.placement ?? null),
          currentMultiplier: isStealthed ? null : rawCurrentMultiplier,
          // Team races (TR-656): stealth masks the individual plank only.
          team: entry.team ?? null,
          forfeitedAt: entry.forfeitedAt ?? null,
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

    // Apply IMPOSTER display swaps (display path only).
    if (imposterEnabledFn() && imposterSwaps.length > 0) {
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

    const myPlacementEntry = viewerEntries.find((e) => e.userId === userId);

    const result = {
      raceId: snapRace.raceId,
      status: snapRace.status,
      endsAt: snapRace.endsAt,
      maxDurationDays: snapRace.maxDurationDays,
      targetSteps: snapRace.targetSteps, // 1.1.4 compat
      participants: leaderboard,
      // Items 12/16 — additive, nullable. `myPlacementHidden` mirrors the
      // GET /races semantics exactly so the client reads one rule on both.
      myPlacement: viewerIsDetoured
        ? null
        : (myPlacementEntry ? myPlacementEntry.placement ?? null : null),
      myPlacementHidden: viewerIsDetoured,
      tournamentId: snapRace.tournamentId,
      tournamentRound: snapRace.tournamentRound,
      tournamentRoundLabel: snapRace.tournamentRoundLabel,
      tournamentName: snapRace.tournamentName,
    };

    if (snapRace.isTeamRace) {
      result.teams = snapshot.teams;
      result.winnerTeam = snapRace.winnerTeam ?? null;
      result.isTeamRace = true;
      result.teamSize = snapRace.teamSize ?? null;
    }

    // §5.3 — additive `dropOdds`, derived from the SAME helpers the roll uses
    // and the SAME true step totals openMysteryBox ranks on.
    if (powerupData && balanceConfigSnapshot && !race._pageProjection) {
      const dropOdds = buildDropOdds({
        race,
        userId,
        // ctx inputs: the SAME true (never illusion-masked) effective totals the
        // roll builds its exclusion predicates from.
        stepTotals: viewerEntries.map((e) => ({
          participant: { userId: e.userId, team: e.team ?? null },
          totalSteps: e.totalSteps,
        })),
        // Position input: the PERSISTED rows, which is what the roll ranks on.
        persistedParticipants: (race._projectionParticipants || race.participants).filter(
          (p) => p.status === "ACCEPTED"
        ),
        snapshot: balanceConfigSnapshot,
        supportsPowerups5,
      });
      if (dropOdds) powerupData.dropOdds = dropOdds;
    }

    if (powerupData) {
      result.powerupData = powerupData;
    }

    let viewerGlobalEvent = null;
    let viewerLookupFailed = false;
    if (typeof globalStepEventModel.findViewerActive === "function") {
      try {
        const local = await globalStepEventModel.findViewerActive({
          userId, raceId, now: nowTime,
        });
        if (local) {
          viewerGlobalEvent = {
            active: true,
            multiplier: Number(local.multiplier),
            endsAt: local.endsAt,
          };
        }
      } catch {
        // Viewer-specific overlay is optional and fail-soft.
        viewerLookupFailed = true;
      }
    }
    // Legacy-global rows remain viewer-independent, but the response field is
    // still assembled after authentication so a shared Redis snapshot never
    // carries one viewer's local entitlement. This preserves the exact old
    // response shape while the local lookup returns no eligible event.
    if (!viewerGlobalEvent && !viewerLookupFailed &&
        typeof globalStepEventModel.findActiveAt === "function") {
      try {
        const legacy = await globalStepEventModel.findActiveAt(nowTime);
        if (legacy) {
          viewerGlobalEvent = {
            active: true,
            multiplier: Number(legacy.multiplier),
            endsAt: legacy.endsAt,
          };
        }
      } catch {
        // The optional banner must never fail race progress.
      }
    }
    if (viewerGlobalEvent) result.globalEvent = viewerGlobalEvent;

    // Requirements §5.2: paging is defined for ACTIVE races, and the server MAY
    // answer non-ACTIVE ones whole "to avoid regressions". It does: a finished
    // race's results screen reads this same payload, and truncating it to ten
    // rows would silently amputate the final standings. `pagination` is still
    // emitted so a paging client can see total == returned and stop asking.
    //
    // DELIBERATE DEVIATION from §5.2, which specified nulling powerupData and
    // globalEvent on a paged response "to keep payload lean". The client polls
    // this every 30s and re-reads both into the powerup rail, the queued-box
    // count and the event banner, so honouring that would blank the powerup UI
    // ~30 seconds after opening any large race and again on every "show more".
    // The participant array IS the payload weight; powerupData is a handful of
    // fields. Paging therefore slices participants and leaves everything else
    // exactly as an unpaged response has it.
    //
    // Team races and non-ACTIVE races are never sliced: their rosters render
    // through paths with no load-more control (team columns, pending roster,
    // final standings), so a page would silently hide members with no way to
    // reveal them.
    const pagingRequested = participantsView === "participants-v1";
    const pageableShape = result.status === "ACTIVE" && !result.isTeamRace;
    if (projectionPagination) {
      result.pagination = projectionPagination;
    } else if (pagingRequested && !pageableShape) {
      const totalParticipants = result.participants.length;
      result.pagination = {
        offset: 0,
        limit: totalParticipants,
        total: totalParticipants,
        hasMore: false,
        nextOffset: totalParticipants,
      };
    } else if (pagingRequested) {
      const totalParticipants = result.participants.length;
      // Shared with the race-details pager (src/shared/pagination) so the two
      // participant arrays on the bootstrap response page by identical rules.
      // The helper owns the offset/limit ARITHMETIC only — the pageable-shape
      // decision above stays here, where its domain reasons are written down.
      const { start, safeLimit, hasMore, nextOffset } = clampOffsetLimit({
        offset: participantsOffset,
        limit: participantsLimit,
        total: totalParticipants,
      });
      result.participants = result.participants.slice(start, start + safeLimit);
      result.pagination = {
        offset: start,
        limit: safeLimit,
        total: totalParticipants,
        hasMore,
        nextOffset,
      };
    }

    // The lean progress context deliberately carries no participant user/
    // accessory graph. Hydrate only the rows that survived illusion masking,
    // imposter swapping, sorting, and page selection. A Detour-masked row is
    // also intentionally skipped: loading its presentation would add work and
    // make it easier for a future serializer change to leak the concealed
    // identity.
    if (hydratePresentation) {
      const visibleIds = result.participants
        .filter(
          (participant) =>
            participant.stealthed !== true && participant.displayName !== "???"
        )
        .map((participant) => participant.userId);
      const presentations = await presentationCache.getMany(visibleIds, true);
      result.participants = result.participants.map((participant) => {
        if (
          participant.stealthed === true ||
          participant.displayName === "???"
        ) {
          return participant;
        }
        const presentation = presentations.get(participant.userId);
        if (!presentation) return participant;
        return {
          ...participant,
          displayName: presentation.displayName,
          profilePhotoUrl: presentation.profilePhotoUrl,
          ...characterPresentation(
            presentation,
            supportsCharacters,
            releaseChannel,
            supportsRemoteAssets
          ),
        };
      });
    }

    if (projectionMetadata && pagingRequested) {
      Object.assign(result, projectionMetadata);
    }

    return result;
  }

  const query = async function getRaceProgress(
    userId,
    raceId,
    timeZone,
    supportsCharacters = false,
    // §9.3 — whether the requesting client advertises `powerups3`. Additive and
    // defaulted false, so every existing caller keeps its exact behavior. Only
    // gates what is RENDERED (the Hitchhike effect entry); the authoritative
    // score is never gated.
    supportsPowerups3 = false,
    supportsPowerups4 = false,
    // §4.5 — whether the client advertises `powerups5`. Gates ONLY what is
    // rendered in activeEffects (downcast/withhold for old clients); the
    // authoritative score is never gated.
    supportsPowerups5 = false,
    // Batch 2026-07-26, item 8. Trailing + optional, defaults to "prod": every
    // existing caller (and every frozen client) keeps identical behaviour.
    releaseChannel = "prod",
    // Batch 2026-08-08 item 11 — whether the client advertises `ads`. Trailing +
    // optional and defaulted false, so every existing caller keeps its exact
    // behaviour. Gates ONLY whether `powerupData.boxReroll` is advertised.
    supportsAds = false,
    // Batch 2026-08-10b item 2. Trailing + optional, defaults null: every
    // existing caller keeps identical behaviour. The user's STORED timezone,
    // used only for the discard-cap local-day boundary.
    userTimeZone = null,
    // Trailing/defaulted capability gate: old direct callers retain the safe
    // no-remote-art presentation.
    supportsRemoteAssets = false,
    resolvedContext = null,
    // Participants pagination (docs/race-participants-pagination-requirements.md
    // §13 REQUIRED) arrives as ONE named options object rather than three more
    // positional arguments. Everything above this line is positional for
    // historical reasons and six of those are booleans defaulting to false, so
    // a transposed pair there is silent — it mis-gates what a client renders
    // rather than throwing. Adding to that tail is how that class of bug grows;
    // new options go here, by name, where order cannot matter.
    {
      participantsView = null,
      participantsOffset = 0,
      participantsLimit = 10,
      // Race preview-before-joining: did the caller advertise `race_preview`?
      // A BOOLEAN computed in routes.js from req.clientFeatures. It only enables
      // the public-preview carve-out — the kill switch and the race's own
      // public/non-tournament shape still have to agree (canReadRacePreview).
      previewViewer = false,
      // Internal typed-target consumer: it needs the complete honest roster,
      // but not the participant user/accessory graph. Its own endpoint flag is
      // the operation gate; the lean context is backed by Postgres and does
      // not depend on Redis standings.
      leanScoringContext = false,
    } = {}
  ) {
    const cacheOn = hasInjectedDependencies
      ? false
      : await standingsCacheEnabled();
    const requestedPage =
      participantsView === "participants-v1" &&
      typeof raceModel.findProgressPageContext === "function";
    // Lean scoring is a projection optimization, not a Redis requirement.
    // Keeping it behind cacheOn made every paged bootstrap fall back to the
    // fat race read during a Redis-disabled capacity run, even though the
    // projection is independently safe and backed by Postgres.
    const leanProjectionEnabled =
      typeof raceModel.findProgressScoringContext === "function" &&
      (leanScoringContext === true ||
        !legacyReplayForTests ||
        (participantsView === "participants-v1" &&
          (await isStrictFlagEnabled(
            settings,
            "raceProgressLeanProjectionV1Enabled"
          ))));
    let pageScopedContext = false;
    let race = requestedPage
      ? await raceModel.findProgressPageContext(raceId, userId)
      : (leanProjectionEnabled
        ? await raceModel.findProgressScoringContext(raceId)
        : await raceModel.findById(raceId));
    if (!race) {
      const error = new Error("Race not found");
      error.statusCode = 404;
      throw error;
    }
    // Lobby/result serializers still require their legacy full graph. ACTIVE
    // solo and team serializers use only scoring rows plus bounded visible
    // presentation, so both can take the lean context.
    pageScopedContext = Boolean(
      requestedPage &&
      race.status === "ACTIVE" &&
      race.isTeamRace !== true &&
      typeof race.timezone === "string" &&
      race.timezone.length > 0
    );
    if (requestedPage && !pageScopedContext) {
      // Null-timezone races score in the requester timezone and therefore
      // cannot share a page projection. Keep their established full path.
      race = leanProjectionEnabled
        ? await raceModel.findProgressScoringContext(raceId)
        : await raceModel.findById(raceId);
    }
    let usingLeanProjection =
      (leanProjectionEnabled && !requestedPage || pageScopedContext) &&
      race.status === "ACTIVE";
    if (leanProjectionEnabled && !usingLeanProjection) {
      race = await raceModel.findById(raceId);
    }
    if (usingLeanProjection) {
      Object.defineProperty(race, "_leanProgressProjection", {
        value: true,
        enumerable: false,
      });
    }
    if (resolvedContext && typeof resolvedContext === "object") {
      resolvedContext.race = race;
    }

    const myParticipant = race.participants.find((p) => p.userId === userId);
    // Mirrors getRaceDetails: declining revokes access to the race.
    //
    // TRUE only on the NEW public-preview branch. Everything this flag gates
    // below is about making the read STRICTLY read-only — see the snapshot block.
    let isPublicPreview = false;
    if (!myParticipant || myParticipant.status === "DECLINED") {
      // Same order, same predicate, same reasoning as getRaceDetails: the cheap
      // in-memory checks first, and the two branches are mutually exclusive
      // (the preview predicate is false whenever tournamentId is set).
      isPublicPreview = await canReadRacePreview({
        race,
        myParticipant,
        previewViewer,
      });
      if (!isPublicPreview) {
        // Tournament spectating: an ACCEPTED bracket player (incl. eliminated)
        // may READ a matchup race they aren't in. Read-only — the powerup-earn
        // block below is skipped for a spectator (no myParticipant), and no
        // write path is relaxed here. Non-tournament races and non-participants
        // still 403.
        const canSpectate =
          race.tournamentId != null &&
          (await isTournamentParticipantFn(race.tournamentId, userId));
        if (!canSpectate) {
          const error = new Error("You are not a participant in this race");
          error.statusCode = 403;
          throw error;
        }
      }
    }

    if (race.status !== "ACTIVE") {
      const acceptedParticipants = race.participants.filter((p) => p.status === "ACCEPTED");
      const nonActiveResult = {
        raceId: race.id,
        status: race.status,
        endsAt: race.endsAt,
        maxDurationDays: race.maxDurationDays,
        targetSteps: race.targetSteps, // 1.1.4 compat
        participants: acceptedParticipants.map((p) => ({
          userId: p.userId,
          displayName: p.user.displayName,
          profilePhotoUrl: p.user.profilePhotoUrl,
          ...characterPresentation(
            p.user,
            supportsCharacters,
            releaseChannel,
            supportsRemoteAssets
          ),
          totalSteps: p.totalSteps,
          finishedAt: p.finishedAt,
          // Team races (additive; null on individual races).
          team: p.team ?? null,
          forfeitedAt: p.forfeitedAt ?? null,
        })),
        ...tournamentFields(race),
      };
      // Team block for the lobby (PENDING sides) and results (COMPLETED
      // totals + winnerTeam). Additive — old clients ignore it.
      if (race.isTeamRace) {
        nonActiveResult.teams = buildTeamsBlock(race, acceptedParticipants.map((p) => ({
          participant: p,
          totalSteps: p.totalSteps || 0,
        })));
        nonActiveResult.winnerTeam = race.winnerTeam ?? null;
        nonActiveResult.isTeamRace = true;
        nonActiveResult.teamSize = race.teamSize ?? null;
      }
      return nonActiveResult;
    }

    // Seeded races bucket steps in their canonical tz so every participant's
    // "midnight" is the same instant AND this live path agrees with settlement
    // (raceExpiry). User-created races (timezone NULL) keep using the
    // requester's header tz — legacy behavior, and the reason the snapshot
    // carries its scoring tz (see cacheKeys.raceProgress).
    const scoringTimeZone = raceTimeZone(race, timeZone);
    const snapshotSchemaVersion = usingLeanProjection
      ? snapshotStore.LEAN_SCHEMA_VERSION
      : snapshotStore.SCHEMA_VERSION;
    const pageScopedRequest =
      participantsView === "participants-v1" &&
      race.status === "ACTIVE" &&
      race.isTeamRace !== true;
    let snapshot;
    let projectionRequesterEntry = null;
    let projectionPagination = null;
    let projectionMetadata = null;
    if (pageScopedContext) {
      const cachedProjection = cacheOn
        ? await pageProjection.readRaceProgressPageProjection({
            raceId,
          offset: participantsOffset,
          limit: participantsLimit,
          requesterUserId: myParticipant ? userId : null,
          scoringTimeZone,
          })
        : null;
      let projectionRows = cachedProjection?.rows || null;
      let projectionAsOf = cachedProjection?.asOf || null;
      let projectionGeneration = cachedProjection?.generation || null;
      let projectionSource = "authoritative";
      let projectionTotal = cachedProjection?.total || null;
      let projectionRace = cachedProjection?.index?.race || null;

      if (!projectionRows) {
        projectionSource = "stale-fallback";
        const persisted = typeof participantModel.findPersistedProgressPage === "function"
          ? await participantModel.findPersistedProgressPage(raceId, {
              offset: participantsOffset,
              limit: participantsLimit,
            })
          : [];
        projectionTotal = Number(persisted[0]?.totalCount || 0);
        const { start, safeLimit, hasMore, nextOffset } = clampOffsetLimit({
          offset: participantsOffset,
          limit: participantsLimit,
          total: projectionTotal,
        });
        // The SQL read is already bounded. Its rows carry their persisted rank;
        // no page-local replay or all-participant hydration occurs here.
        projectionRows = persisted.map((row) => ({
          participantId: row.participantId,
          userId: row.userId,
          totalSteps: Number(row.totalSteps || 0),
          finishedAt: row.finishedAt,
          forfeitedAt: row.forfeitedAt,
          team: row.team,
          placement: Number(row.computedPlacement || 0) || null,
          currentMultiplier: 1,
          baseAdjusted: row.rawSteps ?? null,
          joinedAt: row.joinedAt,
          rawSteps: row.rawSteps,
          finishTotalSteps: row.finishTotalSteps,
        }));
        projectionPagination = {
          offset: start,
          limit: safeLimit,
          total: projectionTotal,
          hasMore,
          nextOffset,
        };
        projectionAsOf = race.updatedAt || race.startedAt || null;
        projectionRace = {
          raceId: race.id,
          status: race.status,
          endsAt: race.endsAt,
          maxDurationDays: race.maxDurationDays,
          targetSteps: race.targetSteps,
          isTeamRace: race.isTeamRace,
          teamSize: race.teamSize ?? null,
          winnerTeam: race.winnerTeam ?? null,
          powerupsEnabled: race.powerupsEnabled,
          powerupStepInterval: race.powerupStepInterval,
          ...tournamentFields(race),
        };
        if (myParticipant && !projectionRows.some((row) => row.userId === userId)) {
          const viewer = persisted.find((row) => row.userId === userId) || myParticipant;
          projectionRequesterEntry = {
            participantId: viewer.participantId || viewer.id,
            userId,
            totalSteps: Number(viewer.totalSteps || 0),
            finishedAt: viewer.finishedAt ?? null,
            forfeitedAt: viewer.forfeitedAt ?? null,
            team: viewer.team ?? null,
            placement: Number(viewer.computedPlacement || viewer.placement || 0) || null,
            currentMultiplier: 1,
            baseAdjusted: viewer.rawSteps ?? null,
          };
        }
      } else {
        projectionPagination = clampOffsetLimit({
          offset: participantsOffset,
          limit: participantsLimit,
          total: cachedProjection.total,
        });
        projectionPagination = {
          offset: projectionPagination.start,
          limit: projectionPagination.safeLimit,
          total: cachedProjection.total,
          hasMore: projectionPagination.hasMore,
          nextOffset: projectionPagination.nextOffset,
        };
        projectionRequesterEntry = cachedProjection.requesterRow;
      }

      const activeEffects = race.powerupsEnabled
        ? await raceActiveEffectModel.findActiveForRace(raceId)
        : [];
      snapshot = snapshotStore.buildSnapshot({
        race: projectionRace,
        participants: projectionRows,
        teams: null,
        activeEffects,
        scoringTimeZone,
        asOf: projectionAsOf,
        source: projectionSource,
        schemaVersion: snapshotStore.LEAN_SCHEMA_VERSION,
      });
      Object.defineProperty(race, "_pageProjection", {
        value: true,
        enumerable: false,
      });
      projectionMetadata = {
        projectionGeneration,
        asOf: projectionAsOf,
        projectionSource,
      };
      if (projectionSource !== "authoritative") {
        await enqueueRaceResolutionFn({
          raceId,
          userId,
          timeZone: scoringTimeZone,
          reason: "DISPLAY_REFRESH",
          priority: "IMMEDIATE",
        });
      }
    } else if (isPublicPreview) {
      // ── STRICTLY READ-ONLY PREVIEW PATH ───────────────────────────────────
      // A stranger browsing the public list must never be able to mutate a race
      // they have no relationship to. Without this branch a single preview tap
      // could (a) win `withRebuildLock` and run a full scoring replay for a
      // 477-participant seeded race, (b) run `computeSharedState({ persist:
      // true })` on the cache-off path — which writes back totalSteps, expires
      // effects and processes high-multiplier claims — and (c) enqueue a
      // DISPLAY_REFRESH resolution job. All three are skipped here: serve
      // whatever snapshot exists REGARDLESS of staleness, else fall through to
      // the read-only persisted read.
      //
      // The staleness tolerance is deliberate. A preview is a browse, not a
      // watch (the client fetches once and does not poll), so a few seconds of
      // drift is invisible — and the alternative is letting an unbounded,
      // unauthenticated-by-membership audience drive the system's most expensive
      // rebuild.
      //
      // ACCEPTED: user-created public races carry `timezone = NULL` and score in
      // the REQUESTER's tz, so a preview viewer in another timezone misses the
      // snapshot and lands on loadPersistedState. That is correct. Do NOT "fix"
      // it by adding timezone to the C3 cache key — that makes the key's
      // invalidation set unenumerable (cacheKeys.js).
      let usable = null;
      if (cacheOn && !snapshotStore.isBypassed()) {
        const cached = await snapshotStore.readSnapshot(
          raceId,
          snapshotSchemaVersion
        );
        if (cached && snapshotStore.matchesTimeZone(cached, scoringTimeZone)) {
          usable = cached;
          snapshotStore.__bump("snapshotHits");
        }
      }
      snapshot =
        usable || (await loadPersistedState({ race, raceId, scoringTimeZone }));
    } else if (!cacheOn) {
      if (hasInjectedDependencies || legacyReplayForTests) {
        // Pure scoring fixtures intentionally exercise the live replay path;
        // the production singleton takes the persisted fallback below.
        snapshot = await computeSharedState({
          race,
          raceId,
          scoringTimeZone,
          persist: true,
        });
      } else {
        // Redis is an acceleration layer, not permission to replay and mutate
        // a whole race from a read request. The worker owns authoritative
        // scoring; when no shared snapshot is available, serve the cheap
        // persisted view. Keep the per-viewer powerup sync seam below for
        // frozen clients, but do not run the race-wide replay, write-back,
        // expiry, or queue enqueue here.
        snapshot = await loadPersistedState({ race, raceId, scoringTimeZone });
      }
    } else if (snapshotStore.isBypassed()) {
      // A DEL failed somewhere in this process, so a KNOWN-STALE snapshot may
      // still be sitting in Redis. Serve Postgres until the retry lands (§3).
      snapshot = await loadPersistedState({ race, raceId, scoringTimeZone });
    } else {
      const cached = await snapshotStore.readSnapshot(
        raceId,
        snapshotSchemaVersion
      );
      const usable =
        cached && snapshotStore.matchesTimeZone(cached, scoringTimeZone)
          ? cached
          : null;

      if (usable && snapshotStore.isFresh(usable, now().getTime())) {
        snapshotStore.__bump("snapshotHits");
        snapshot = usable;
      } else {
        let displayArtifactRef = null;
        // Miss or soft-expiry. Exactly ONE request rebuilds; the lock
        // self-expires (PX) so a crashed winner cannot wedge it.
        const startRebuild = () => snapshotStore.withRebuildLock(raceId, async () => {
          snapshotStore.__bump("requestReplays");
          let fresh = null;
          let artifactEnabled = false;
          try {
            artifactEnabled = await displayArtifactReuseEnabled();
          } catch {
            artifactEnabled = false;
          }
          if (artifactEnabled) {
            try {
              const configA = await balanceConfig.getSnapshot();
              const fingerprintA = await buildInputFingerprint({
                raceId,
                now: now(),
                balanceConfigVersion: configA.version,
              });
              if (fingerprintA) {
                const computed = await computeRaceState({
                  raceId,
                  timeZone: scoringTimeZone,
                  userIds: [userId],
                });
                const configB = await balanceConfig.getSnapshot();
                const fingerprintB = await buildInputFingerprint({
                  raceId,
                  now: now(),
                  balanceConfigVersion: configB.version,
                });
                const result = computed?.result || null;
                fresh = buildSnapshotFromResolution({
                  result,
                  race,
                  scoringTimeZone,
                });
                const reuseDeadline = fingerprintB && result
                  ? computeArtifactReuseDeadline({
                      asOf: result.displayCapture?.asOf,
                      timeZone: scoringTimeZone,
                      raceEndsAt: result.race?.endsAt,
                      nextSampleBoundary: fingerprintB.nextSampleBoundary,
                      activeEffects: fingerprintB.activeEffects,
                      globalEvents: fingerprintB.globalEvents,
                    })
                  : null;
                if (
                  fresh &&
                  reuseDeadline &&
                  fingerprintA.digest === fingerprintB?.digest &&
                  String(configA.version ?? "code-default") ===
                    String(configB.version ?? "code-default")
                ) {
                  displayArtifactRef = await displayArtifactStore.put({
                    raceId,
                    timeZone: scoringTimeZone,
                    triggeringUserIds: [userId].filter(Boolean).sort(),
                    participants: result.displayCapture.stepTotals,
                    inputFingerprint: fingerprintB.digest,
                    balanceConfigVersion: configB.version ?? null,
                    reuseDeadline: reuseDeadline.toISOString(),
                    writes: computed.writes,
                    result,
                  });
                }
              }
            } catch {
              displayArtifactRef = null;
            }
          }
          if (!fresh) {
            fresh = await computeSharedState({
              race,
              raceId,
              scoringTimeZone,
              persist: false,
            });
          }
          await snapshotStore.writeSnapshot(raceId, fresh);
          return fresh;
        });

        if (usable) {
          // Serve stale-while-revalidate: the valid snapshot is immediately
          // usable, while the lock owner refreshes it in the background.
          snapshotStore.__bump("staleServes");
          snapshot = usable;
          void startRebuild()
            .then(async (rebuilt) => {
              if (!rebuilt) return;
              await enqueueRaceResolutionFn({
                raceId,
                userId,
                timeZone: scoringTimeZone,
                reason: "DISPLAY_REFRESH",
                priority: "IMMEDIATE",
                displayArtifact: displayArtifactRef,
              });
            })
            .catch((error) => {
              logger.warn?.("Race progress background refresh failed", {
                raceId,
                error: error?.message || "unknown",
              });
            });
        } else if (pageScopedRequest) {
          // A cold paged request must not wait for the race-wide replay. The
          // persisted projection is safe for an immediate page response;
          // the canonical replay remains owned by the background refresh and
          // will publish the exact live-effect ranking for subsequent reads.
          snapshot = await loadPersistedState({ race, raceId, scoringTimeZone });
          // Queue the canonical refresh; do not start the replay in this
          // request. The resolution worker owns the expensive race-wide
          // calculation and coalesces concurrent DISPLAY_REFRESH requests.
          await enqueueRaceResolutionFn({
            raceId,
            userId,
            timeZone: scoringTimeZone,
            reason: "DISPLAY_REFRESH",
            priority: "IMMEDIATE",
            displayArtifact: displayArtifactRef,
          });
        } else {
          const rebuilt = await startRebuild();
          if (rebuilt) {
            snapshot = rebuilt;
            // Phase D step 8: progress polls keep persisted totals converging
            // for a watched race by enqueueing its race-keyed job on expiry.
            await enqueueRaceResolutionFn({
              raceId,
              userId,
              timeZone: scoringTimeZone,
              reason: "DISPLAY_REFRESH",
              priority: "IMMEDIATE",
              displayArtifact: displayArtifactRef,
            });
          } else {
            // True cold start. Wait on REDIS ONLY for at most 1s — zero pooled
            // Postgres connections are held, which is the explicit
            // anti-recurrence guard for the 2026-07-18 advisory-lock pool drain.
            // Skipped entirely when Redis is unreachable (no snapshot can appear),
            // so a Redis outage costs a PING, not a second, per request.
            let waited = null;
            if ((await redisCache.healthStatus()) === "ok") {
              waited = await snapshotStore.waitForSnapshot(
                raceId,
                scoringTimeZone,
                undefined,
                snapshotSchemaVersion
              );
            }
            if (waited) {
              snapshotStore.__bump("staleServes");
              snapshot = waited;
            } else {
              // Losers NEVER fall through to the replay.
              snapshot = await loadPersistedState({ race, raceId, scoringTimeZone });
            }
          }
        }
      }
    }

    if (participantsView === "participants-v1" && !projectionMetadata) {
      projectionMetadata = { projectionSource: "legacy" };
    }
    return buildViewerResponse({
      snapshot,
      race,
      raceId,
      userId,
      myParticipant,
      scoringTimeZone,
      supportsCharacters,
      supportsRemoteAssets,
      supportsPowerups3,
      supportsPowerups4,
      supportsPowerups5,
      releaseChannel,
      supportsAds,
      userTimeZone,
      // The powerup box-gate sync WRITES race_participants and mints RacePowerup
      // rows. It is already unreachable for a preview viewer (the whole block is
      // gated on `myParticipant`, which they do not have), but this is the
      // response builder's own write seam and the read-only contract is worth
      // stating at it rather than relying on a guard two functions away.
      syncPowerups: !cacheOn && !isPublicPreview,
      participantsView,
      participantsOffset,
      participantsLimit,
      hydratePresentation: usingLeanProjection,
      requesterEntry: projectionRequesterEntry,
      projectionPagination,
      projectionMetadata,
    });
  };

  // C3 — the OTHER caller of the one allowlist builder (spec §5 Phase D item 4
  // / §5a item 5). The race-keyed v2 worker calls this from its post-commit
  // hook to SET (replace) the race's snapshot with the freshest possible view.
  // It is the SAME `computeSharedState` the request path's lock winner runs, so
  // there is no second snapshot shape to keep in lockstep — and it is
  // `persist: false`, so the publish itself writes nothing to Postgres.
  query.computeSharedSnapshot = async ({ raceId, timeZone = "UTC" }) => {
    const race =
      typeof raceModel.findProgressScoringContext === "function"
        ? await raceModel.findProgressScoringContext(raceId)
        : await raceModel.findById(raceId);
    if (!race || race.status !== "ACTIVE") return null;
    if (typeof raceModel.findProgressScoringContext === "function") {
      Object.defineProperty(race, "_leanProgressProjection", {
        value: true,
        enumerable: false,
      });
    }
    return computeSharedState({
      race,
      raceId,
      scoringTimeZone: raceTimeZone(race, timeZone),
      persist: false,
    });
  };

  // The worker has just committed these exact totals, so publishing them does
  // not need a second race-wide scoring replay. The shape is the same shared
  // snapshot used by the Redis-outage fallback; only the source label differs.
  query.computePersistedSnapshot = async ({
    raceId,
    timeZone = "UTC",
    baseAdjustedByParticipantId = null,
  }) => {
    const race =
      typeof raceModel.findProgressScoringContext === "function"
        ? await raceModel.findProgressScoringContext(raceId)
        : await raceModel.findById(raceId);
    if (!race || race.status !== "ACTIVE") return null;
    if (typeof raceModel.findProgressScoringContext === "function") {
      Object.defineProperty(race, "_leanProgressProjection", {
        value: true,
        enumerable: false,
      });
    }
    const snapshot = await loadPersistedState({
      race,
      raceId,
      scoringTimeZone: raceTimeZone(race, timeZone),
      baseAdjustedByParticipantId,
    });
    snapshot.source = "worker-persisted";
    return snapshot;
  };

  return query;
}

const getRaceProgress = buildGetRaceProgress();

module.exports = { getRaceProgress, buildGetRaceProgress, computeEffectModifiers };
