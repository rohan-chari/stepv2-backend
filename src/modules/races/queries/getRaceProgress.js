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
const { GlobalStepEvent } = require("../../steps/models/globalStepEvent");
const { computeGlobalEventBoost } = require("../../steps/globalStepEvent");
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

// The (releaseChannel × supportsCharacters) combinations `characterPresentation`
// can produce. Closed set: `resolveReleaseChannel` only ever yields "prod" or
// "testflight". Precomputing all four keeps raw `equippedAccessories` rows (and
// their Date columns) out of the snapshot while staying byte-identical to what
// the uncached response would have emitted.
const PRESENTATION_CHANNELS = ["prod", "testflight"];

function presentationKey(channel, supportsCharacters) {
  return `${channel}:${supportsCharacters ? 1 : 0}`;
}

function buildPresentationVariants(user) {
  const out = {};
  for (const channel of PRESENTATION_CHANNELS) {
    for (const supportsCharacters of [false, true]) {
      out[presentationKey(channel, supportsCharacters)] = characterPresentation(
        user,
        supportsCharacters,
        channel
      );
    }
  }
  return out;
}

function readPresentation(entry, channel, supportsCharacters) {
  const variants = entry.presentation || {};
  return (
    variants[presentationKey(channel, supportsCharacters)] ||
    variants[presentationKey("prod", supportsCharacters)] || {
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
  const settings = deps.appSettings || defaultAppSettings;
  const enqueueRaceResolutionFn =
    deps.enqueueRaceResolution || defaultEnqueueRaceResolution;
  const recentBoxMintsStore = deps.recentBoxMints || defaultRecentBoxMints;

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
    const nowParts = getTimeZoneParts(now(), scoringTimeZone);
    const today = formatDateString(nowParts.year, nowParts.month, nowParts.day);
    const acceptedParticipants = race.participants.filter(
      (p) => p.status === "ACCEPTED"
    );

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
        const startDayWindowEnd = zonedDateTimeToUtc({
          year: dayAfterParsed.year,
          month: dayAfterParsed.month,
          day: dayAfterParsed.day,
          hour: 0,
          minute: 0,
          second: 0,
        }, scoringTimeZone);

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
        const startDaySamples = await stepSampleModel.sumStepsInWindow(
          p.userId, effectiveStart, startDayWindowEnd
        );
        if (startsAtLocalMidnight) {
          const startDayRow = await stepsModel.findByUserIdAndDate(p.userId, startDate);
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
          stepsModel,
          stepSampleModel,
          now: now(),
        });

        const baseAdjusted = Math.max(0, startDaySteps + subsequentSteps);
        let hasSampleData = startDaySamples > 0;
        if (!hasSampleData && typeof stepSampleModel.hasAnyInWindow === "function") {
          hasSampleData = await stepSampleModel.hasAnyInWindow(
            p.userId,
            effectiveStart,
            now()
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
    try {
      globalEvents =
        (await globalStepEventModel.findActiveInRange(raceStartedAt, now())) ||
        [];
    } catch {
      globalEvents = [];
    }
    const globalContext = { globalEvents, now: now() };

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
          legCramps = await raceActiveEffectModel.findEffectsForRaceByType(raceId, participant.id, "LEG_CRAMP");
          legCramps.push(...await raceActiveEffectModel.findEffectsForRaceByType(raceId, participant.id, "QUICKSAND"));
          runnersHighs = await raceActiveEffectModel.findEffectsForRaceByType(raceId, participant.id, "RUNNERS_HIGH");
          wrongTurns = await raceActiveEffectModel.findEffectsForRaceByType(raceId, participant.id, "WRONG_TURN");
          campfires = await raceActiveEffectModel.findEffectsForRaceByType(raceId, participant.id, "CAMPFIRE_REST");
          rainstorms = await raceActiveEffectModel.findEffectsForRaceByType(raceId, participant.id, "RAINSTORM");
          leeches = await raceActiveEffectModel.findEffectsForRaceByType(raceId, participant.id, "LEECH");
          if (typeof raceActiveEffectModel.findEffectsForRaceByTypes === "function") {
            const w5 = await raceActiveEffectModel.findEffectsForRaceByTypes(
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
        const { frozenSteps, buffedSteps, reversedSteps, globalBoostedSteps, leechTransfers } = await computeEffectModifiers(allEffects, baseAdjusted, participant.userId, stepSampleModel, hasSampleData, globalContext, now());

        const preLeechTotal = Math.max(0, baseAdjusted - frozenSteps + buffedSteps - 2 * reversedSteps + (globalBoostedSteps || 0) + (race.powerupsEnabled ? (participant.bonusSteps || 0) : 0));

        // §6a — the SIGNED effective multiplier right now.
        const currentMultiplierRaw = race.powerupsEnabled
          ? signedMultiplierForEffects(allEffects, now().getTime())
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
          raceActiveEffectModel,
          stepSampleModel,
          now: now(),
          globalEvents,
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
      ? await raceActiveEffectModel.findActiveForRace(raceId)
      : [];

    // §6a — per-participant CURRENT MULTIPLIER, with any active global 2x event
    // folded into the MAGNITUDE (sign preserved).
    const nowTime = now();
    const nowMsForMult = nowTime.getTime();
    const activeEventForMult = globalEvents.find((ev) => {
      const s = new Date(ev.startsAt).getTime();
      const e = new Date(ev.endsAt).getTime();
      return s <= nowMsForMult && nowMsForMult < e && Number(ev.multiplier) > 1;
    });
    const eventMult = activeEventForMult ? Number(activeEventForMult.multiplier) : 1;
    const multiplierByParticipantId = new Map();
    for (const e of preLeech) {
      const raw = e.frozen ? 1 : (e.currentMultiplierRaw ?? 1);
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
            now,
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

    const updatedRace = await raceModel.findById(raceId);
    const raceForStatus = updatedRace || race;

    // Team H2H block (TR-401), computed from TRUE totals before any display
    // illusion — always honest (TR-658).
    const teams = race.isTeamRace ? buildTeamsBlock(race, stepTotals) : null;

    // Additive: the currently-active global step event, if any.
    const nowMsForEvent = now().getTime();
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
        displayName: participant.user.displayName,
        profilePhotoUrl: participant.user.profilePhotoUrl,
        presentation: buildPresentationVariants(participant.user),
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
    });
  }

  // ── THE CHEAP PERSISTED-COLUMNS READ (viewer-free) ─────────────────────────
  //
  // Phase D step 7's pinned fallback: what a lock LOSER on a true cold start
  // serves, and what EVERY request serves while Redis is down. It runs the
  // `getRaceDetails` shape — persisted `totalSteps` + the shared placement
  // comparator — plus one indexed read of the race's active effects so the
  // effects panel and the multiplier badge do not blank out. It NEVER runs the
  // replay, and it is never published to Redis (it is not authoritative).
  async function loadPersistedState({ race, raceId, scoringTimeZone }) {
    snapshotStore.__bump("persistedFallbacks");
    const accepted = race.participants.filter((p) => p.status === "ACCEPTED");
    const raceActiveEffects = race.powerupsEnabled
      ? await raceActiveEffectModel.findActiveForRace(raceId)
      : [];

    let globalEvents = [];
    try {
      globalEvents =
        (await globalStepEventModel.findActiveInRange(race.startedAt, now())) || [];
    } catch {
      globalEvents = [];
    }

    const nowTime = now();
    const nowMs = nowTime.getTime();
    const activeEvent = globalEvents.find((ev) => {
      const startMs = new Date(ev.startsAt).getTime();
      const endMs = new Date(ev.endsAt).getTime();
      return startMs <= nowMs && nowMs < endMs;
    });
    const eventMult =
      activeEvent && Number(activeEvent.multiplier) > 1
        ? Number(activeEvent.multiplier)
        : 1;

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
      return {
        participantId: p.id,
        userId: p.userId,
        displayName: p.user.displayName,
        profilePhotoUrl: p.user.profilePhotoUrl,
        presentation: buildPresentationVariants(p.user),
        totalSteps: totalFor(p),
        finishedAt: p.finishedAt,
        forfeitedAt: p.forfeitedAt ?? null,
        team: p.team ?? null,
        placement: placementByUserId.get(p.userId) ?? null,
        currentMultiplier: raw * eventMult,
        // Unknown without the replay. The requester's own box countdown falls
        // back to a per-user `calculateBaseAdjusted` in the overlay.
        baseAdjusted: null,
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
      globalEvent: activeEvent
        ? {
            active: true,
            multiplier: Number(activeEvent.multiplier),
            endsAt: activeEvent.endsAt,
          }
        : null,
      activeEffects: raceActiveEffects,
      scoringTimeZone,
      asOf: nowTime,
      source: "persisted",
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
  }) {
    const snapRace = snapshot.race || {};
    const entries = snapshot.participants || [];
    const raceActiveEffects = snapshot.activeEffects || [];
    const nowTime = now();

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
      const myEntry = entries.find((e) => e.participantId === myParticipant.id);
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
            totalSteps: null,
            finishedAt: entry.finishedAt,
            stealthed: false,
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
            : readPresentation(entry, releaseChannel, supportsCharacters)),
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

    const myPlacementEntry = entries.find((e) => e.userId === userId);

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
    if (powerupData && balanceConfigSnapshot) {
      const dropOdds = buildDropOdds({
        race,
        userId,
        // ctx inputs: the SAME true (never illusion-masked) effective totals the
        // roll builds its exclusion predicates from.
        stepTotals: entries.map((e) => ({
          participant: { userId: e.userId, team: e.team ?? null },
          totalSteps: e.totalSteps,
        })),
        // Position input: the PERSISTED rows, which is what the roll ranks on.
        persistedParticipants: race.participants.filter(
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

    if (snapshot.globalEvent) {
      result.globalEvent = snapshot.globalEvent;
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
    userTimeZone = null
  ) {
    const race = await raceModel.findById(raceId);
    if (!race) {
      const error = new Error("Race not found");
      error.statusCode = 404;
      throw error;
    }

    const myParticipant = race.participants.find((p) => p.userId === userId);
    // Mirrors getRaceDetails: declining revokes access to the race.
    if (!myParticipant || myParticipant.status === "DECLINED") {
      // Tournament spectating: an ACCEPTED bracket player (incl. eliminated) may
      // READ a matchup race they aren't in. Read-only — the powerup-earn block
      // below is skipped for a spectator (no myParticipant), and no write path
      // is relaxed here. Non-tournament races and non-participants still 403.
      const canSpectate =
        race.tournamentId != null &&
        (await isTournamentParticipantFn(race.tournamentId, userId));
      if (!canSpectate) {
        const error = new Error("You are not a participant in this race");
        error.statusCode = 403;
        throw error;
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
          ...characterPresentation(p.user, supportsCharacters, releaseChannel),
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
    const cacheOn = await standingsCacheEnabled();

    let snapshot;
    if (!cacheOn) {
      // Flag OFF: byte-for-byte today's behavior — the replay AND its three
      // side effects (expireEffects, the updateTotalSteps write-back, the
      // high-multiplier claim) run exactly where they always did.
      snapshot = await computeSharedState({
        race,
        raceId,
        scoringTimeZone,
        persist: true,
      });
    } else if (snapshotStore.isBypassed()) {
      // A DEL failed somewhere in this process, so a KNOWN-STALE snapshot may
      // still be sitting in Redis. Serve Postgres until the retry lands (§3).
      snapshot = await loadPersistedState({ race, raceId, scoringTimeZone });
    } else {
      const cached = await snapshotStore.readSnapshot(raceId);
      const usable =
        cached && snapshotStore.matchesTimeZone(cached, scoringTimeZone)
          ? cached
          : null;

      if (usable && snapshotStore.isFresh(usable, now().getTime())) {
        snapshotStore.__bump("snapshotHits");
        snapshot = usable;
      } else {
        // Miss or soft-expiry. Exactly ONE request rebuilds; the lock
        // self-expires (PX) so a crashed winner cannot wedge it.
        const rebuilt = await snapshotStore.withRebuildLock(raceId, async () => {
          snapshotStore.__bump("requestReplays");
          const fresh = await computeSharedState({
            race,
            raceId,
            scoringTimeZone,
            persist: false,
          });
          await snapshotStore.writeSnapshot(raceId, fresh);
          return fresh;
        });

        if (rebuilt) {
          snapshot = rebuilt;
          // Phase D step 8: progress polls keep persisted totals converging for
          // a watched race by enqueueing ITS race-keyed job — on snapshot
          // EXPIRY, not on every poll, so the watch-driven cadence is 15s
          // (§5a item 3). Best-effort by contract.
          await enqueueRaceResolutionFn({
            raceId,
            userId,
            timeZone: scoringTimeZone,
          });
        } else if (usable) {
          // Lock loser with a stale-but-present snapshot: serve it. This is why
          // the key physically lives 60s past its 15s soft freshness.
          snapshotStore.__bump("staleServes");
          snapshot = usable;
        } else {
          // True cold start. Wait on REDIS ONLY for at most 1s — zero pooled
          // Postgres connections are held, which is the explicit
          // anti-recurrence guard for the 2026-07-18 advisory-lock pool drain.
          // Skipped entirely when Redis is unreachable (no snapshot can appear),
          // so a Redis outage costs a PING, not a second, per request.
          let waited = null;
          if ((await redisCache.healthStatus()) === "ok") {
            waited = await snapshotStore.waitForSnapshot(raceId, scoringTimeZone);
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

    return buildViewerResponse({
      snapshot,
      race,
      raceId,
      userId,
      myParticipant,
      scoringTimeZone,
      supportsCharacters,
      supportsPowerups3,
      supportsPowerups4,
      supportsPowerups5,
      releaseChannel,
      supportsAds,
      userTimeZone,
      syncPowerups: !cacheOn,
    });
  };

  // C3 — the OTHER caller of the one allowlist builder (spec §5 Phase D item 4
  // / §5a item 5). The race-keyed v2 worker calls this from its post-commit
  // hook to SET (replace) the race's snapshot with the freshest possible view.
  // It is the SAME `computeSharedState` the request path's lock winner runs, so
  // there is no second snapshot shape to keep in lockstep — and it is
  // `persist: false`, so the publish itself writes nothing to Postgres.
  query.computeSharedSnapshot = async ({ raceId, timeZone = "UTC" }) => {
    const race = await raceModel.findById(raceId);
    if (!race || race.status !== "ACTIVE") return null;
    return computeSharedState({
      race,
      raceId,
      scoringTimeZone: raceTimeZone(race, timeZone),
      persist: false,
    });
  };

  return query;
}

const getRaceProgress = buildGetRaceProgress();

module.exports = { getRaceProgress, buildGetRaceProgress, computeEffectModifiers };
