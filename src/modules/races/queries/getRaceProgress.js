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
const {
  rarityOddsForPosition,
  typeOddsForPosition,
  buildRollContext,
  RARITY_ORDER,
} = require("../../powerups/powerupOdds");
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
function buildDropOdds({ race, userId, stepTotals, myParticipant, snapshot, supportsPowerups5 = false }) {
  const { version, config } = snapshot;
  let position;
  let totalParticipants;

  if (race.isTeamRace) {
    const teamTotals = { TEAM_A: 0, TEAM_B: 0 };
    for (const { participant, totalSteps } of stepTotals) {
      if (participant.team === "TEAM_A") teamTotals.TEAM_A += totalSteps || 0;
      else if (participant.team === "TEAM_B") teamTotals.TEAM_B += totalSteps || 0;
    }
    const myTeam = myParticipant.team;
    if (myTeam !== "TEAM_A" && myTeam !== "TEAM_B") return null;
    const otherTeam = myTeam === "TEAM_A" ? "TEAM_B" : "TEAM_A";
    position = teamTotals[myTeam] < teamTotals[otherTeam] ? 2 : 1;
    totalParticipants = 2;
  } else {
    const sorted = [...stepTotals].sort((a, b) => b.totalSteps - a.totalSteps);
    const index = sorted.findIndex(
      ({ participant }) => participant.userId === userId
    );
    if (index === -1) return null;
    position = index + 1;
    totalParticipants = sorted.length;
  }

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

  return async function getRaceProgress(
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
    releaseChannel = "prod"
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

    // Expire timed effects before calculating
    const participantStepsMap = {};
    // Seeded races bucket steps in their canonical tz (e.g. America/New_York) so
    // every participant's "midnight" is the same instant AND this live path agrees
    // with settlement (raceExpiry). User-created races (timezone NULL) keep using
    // the requester's header tz — legacy behavior.
    const scoringTimeZone = raceTimeZone(race, timeZone);
    const nowParts = getTimeZoneParts(now(), scoringTimeZone);
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
        const startParts = getTimeZoneParts(effectiveStart, scoringTimeZone);
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
        }, scoringTimeZone);

        // Start-of-local-day instant in the scoring tz. When the race begins
        // EXACTLY at local midnight (a midnight-aligned seeded race, for on-time /
        // pre-registered entrants), the start day is a FULL day: pre-race steps
        // that day are impossible, so the authoritative daily total is safe to use
        // as a fallback when hourly samples haven't synced yet.
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

        // For the start day: try StepSample for precise post-start steps
        let startDaySteps = 0;
        const startDaySamples = await stepSampleModel.sumStepsInWindow(
          p.userId, effectiveStart, startDayWindowEnd
        );
        if (startsAtLocalMidnight) {
          // Full start day: max(daily total, samples) — same rule as later days,
          // so a daily-only sync still counts and doesn't strand the user at 0.
          const startDayRow = await stepsModel.findByUserIdAndDate(p.userId, startDate);
          startDaySteps = Math.max(startDaySamples, startDayRow?.steps ?? 0);
        } else if (startDaySamples > 0) {
          // Partial start day (mid-day / late joiner): only post-start samples are
          // safe — a later daily-total sync can include pre-join steps that were
          // not present at the join instant.
          startDaySteps = startDaySamples;
        }

        // For days after the start day: per-day max(samples, daily). The race
        // must never count fewer steps than the authoritative daily total for
        // the covered period, and a stale daily row must never suppress larger
        // samples. SHARED with the settlement path (raceStateResolution.js) via
        // calculateSubsequentSteps so display and settlement stay identical.
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
        // See calculateBaseAdjusted (raceStateResolution.js) for the rationale:
        // the start-day sliver alone pinned night-started races to the crude
        // fallback forever, zeroing timed buffs and Leech. Kept identical here so
        // display and settlement agree. Short-circuits, so the common case
        // (samples on the start day) adds no query.
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

    // Second pass, phase A: per-participant PRE-LEECH total + the leeches
    // targeting each participant. Leech is a cross-participant zero-sum transfer,
    // so it can't be folded per-participant here — it is resolved race-wide in
    // phase B (applyLeechTransfers) against real victim availability. Frozen
    // (finished/forfeited) participants keep their stored totals and take no part
    // in the transfer.
    const preLeech = await Promise.all(
      rawStepTotals.map(async ({ participant, baseAdjusted, hasSampleData, effectiveStart }) => {
        // TR-601: forfeited team-race members stay FROZEN at the forfeit
        // snapshot — never recomputed on the display path either.
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
          // Fetch all Leg Cramp, Runner's High, and Wrong Turn effects (active + expired) for this participant
          legCramps = await raceActiveEffectModel.findEffectsForRaceByType(raceId, participant.id, "LEG_CRAMP");
          legCramps.push(...await raceActiveEffectModel.findEffectsForRaceByType(raceId, participant.id, "QUICKSAND"));
          runnersHighs = await raceActiveEffectModel.findEffectsForRaceByType(raceId, participant.id, "RUNNERS_HIGH");
          wrongTurns = await raceActiveEffectModel.findEffectsForRaceByType(raceId, participant.id, "WRONG_TURN");
          campfires = await raceActiveEffectModel.findEffectsForRaceByType(raceId, participant.id, "CAMPFIRE_REST");
          rainstorms = await raceActiveEffectModel.findEffectsForRaceByType(raceId, participant.id, "RAINSTORM");
          // Leech effects targeting this participant (§5). Scored from the
          // leecher's step history inside computeEffectModifiers as a transfer.
          leeches = await raceActiveEffectModel.findEffectsForRaceByType(raceId, participant.id, "LEECH");
          // Powerups Wave 5 windowed step-modifiers (§3) — same fold as the
          // settlement path (raceStateResolution) so display == settlement.
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

        // Pre-leech total: everything EXCEPT the leech transfer, floored at 0.
        const preLeechTotal = Math.max(0, baseAdjusted - frozenSteps + buffedSteps - 2 * reversedSteps + (globalBoostedSteps || 0) + (race.powerupsEnabled ? (participant.bonusSteps || 0) : 0));

        // §6a — the SIGNED effective multiplier right now (buff stacking; the
        // global-event fold is applied by the caller once). LEECH is a transfer,
        // not a rate, so it is correctly ignored by signedMultiplierForEffects.
        const currentMultiplierRaw = race.powerupsEnabled
          ? signedMultiplierForEffects(allEffects, now().getTime())
          : 1;

        return { participant, frozen: false, preLeechTotal, leechTransfers, currentMultiplierRaw };
      })
    );

    // Phase A2 — HITCHHIKE (§7.3). ONE bulk query for every link in the race,
    // scored from each TARGET's raw in-window steps and folded into the CASTER's
    // pre-leech total. This MUST run BEFORE applyLeechTransfers: copied steps are
    // ordinary steps for every downstream purpose, so a Leech on the caster can
    // drain them (§7.1). It is added at the ASSEMBLY, never into baseAdjusted —
    // that is what structurally keeps Hitchhike out of mystery-box progress
    // (computeBoxEffectiveSteps is max(0, baseAdjusted)).
    //
    // The SAME two lines appear in raceStateResolution.processRace and
    // raceExpiry. All three assembly sites must stay in lockstep; the parity
    // guard in test/queries/hitchhikeScoring.test.js fails if one drifts.
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

    // Phase B: resolve every leech across the race against actual availability,
    // draining victims and crediting attackers (zero-sum, deterministic order).
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

    // Update total steps for each active participant. Race completion is now
    // strictly time-based (handled by raceExpiry cron); no step-goal finish.
    for (const { participant, totalSteps } of stepTotals) {
      if (!participant.finishedAt && !participant.forfeitedAt) {
        await participantModel.updateTotalSteps(participant.id, totalSteps);
      }
    }

    // Roll powerups for the requesting user if they crossed a threshold
    let powerupData = null;
    let balanceConfigSnapshot = null;

    // Spectators (no myParticipant) never earn powerups — skip the whole block.
    if (myParticipant && race.powerupsEnabled && race.powerupStepInterval) {
      const myStepTotalEntry = stepTotals.find(
        ({ participant }) => participant.id === myParticipant.id
      );
      const myCurrentSteps =
        myStepTotalEntry?.totalSteps ??
        myParticipant.finishTotalSteps ??
        myParticipant.totalSteps ??
        0;
      // Box progress tracks RAW walked steps — immune to every buff/debuff
      // multiplier (the leaderboard total stays effect-sensitive). It buckets
      // calendar days in the SAME tz the leaderboard uses — boxTz =
      // raceTimeZone(race, "UTC"): the race's canonical persisted tz if set, else
      // the literal constant "UTC". Critically the fallback is a CONSTANT, never
      // the request `timeZone`, so box progress is identical regardless of the
      // caller's device tz (a request-tz basis once left the countdown clamped
      // flat at one interval for non-UTC users). For a race with a canonical tz
      // (all seeded + creator-tz user races) boxTz === scoringTimeZone, so we
      // REUSE the leaderboard baseAdjusted already computed above — box and
      // leaderboard then agree by construction (no inline-vs-shared drift). A
      // non-ACCEPTED requester has no map entry, and a null-tz race is not
      // reusable; both fall through to a recompute in the fixed boxTz. Lazy
      // require breaks the getRaceProgress <-> raceStateResolution import cycle.
      const boxTz = raceTimeZone(race, "UTC");
      const reusedLeaderboardBase = participantStepsMap[myParticipant.id];
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
      const syncResult = await syncRacePowerupState({
        raceId,
        userId,
        boxEffectiveSteps: myBoxEffectiveSteps,
      });
      // One config read per request; the same snapshot feeds the upgrade
      // ladders below and the dropOdds block further down, so a client can
      // never be shown two different versions' numbers in one payload.
      balanceConfigSnapshot = await balanceConfig.getSnapshot();
      powerupData = {
        enabled: true,
        newMysteryBoxes: syncResult.newMysteryBoxes || [],
        newQueuedBoxes: syncResult.newQueuedBoxes || 0,
        powerupStepInterval: race.powerupStepInterval,
        // Authoritative upgrade price ladders so clients display what the
        // server will actually charge. Additive: old clients ignore this and
        // fall back to their bundled (possibly stale) tables.
        // Unchanged SHAPE, now sourced from the balance config instead of a
        // hardcoded table. Frozen clients read this exactly as before.
        upgradeCosts: {
          byRarity: balanceConfigSnapshot.config.upgradeCosts.byRarity,
          byType: balanceConfigSnapshot.config.upgradeCosts.byType,
        },
        // Canonical rarity per powerup, served verbatim from config. Additive:
        // a frozen client ignores it and keeps using its bundled map (which
        // labels SHORTCUT COMMON). A client that reads it gets the server's
        // answer, which is what makes the SHORTCUT mislabel self-heal on update
        // rather than persist forever. Covers the full enum, so nothing silently
        // falls back to COMMON.
        rarityByType: balanceConfigSnapshot.config.rarityByType,
        // §6.2 — additive capability flags. A NEW client must not offer targeted
        // Pocket Watch unless it sees pocketWatchTargetEffect === true: an OLDER
        // backend simply ignores an unknown `targetEffectId` and runs the legacy
        // self-buff path, which would silently extend the wrong effects. Missing,
        // null, or malformed capability data means legacy mode only.
        capabilities: {
          pocketWatchTargetEffect: true,
        },
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
        // §9.3: withhold HITCHHIKE entries from clients that don't advertise
        // `powerups3` — they cannot render the type, and sending an unknown type
        // to a binary that can't draw it risks a worse failure than the accepted
        // artifact (the target sees the caster's total climb with no icon). The
        // SCORE is never gated: the backend stays authoritative either way.
        .filter((e) => supportsPowerups3 || e.type !== "HITCHHIKE")
        // §4.5: wave-5 types a non-powerups5 client cannot render are WITHHELD
        // (GHOST_PEPPER/COIN_FLIP/DECOY/UMBRELLA/PIGGY_BANK/DRILL_SERGEANT/BOUNTY);
        // POWER_OUTAGE/UPRISING/RALLY_FLAG are DOWNCAST below to a type the old
        // client already knows. The score is authoritative regardless.
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
            // Additive: the targeted Pocket Watch sheet needs a stable identifier
            // for the one effect the user is paying to extend.
            id: e.id,
            type,
            expiresAt: e.expiresAt,
            onSelf: e.targetUserId === userId,
            targetUserId: e.targetUserId,
            sourceUserId: e.sourceUserId,
          };
          // Piggy Bank live "banked so far" counter (display-only). Present ONLY
          // on the viewer's OWN active piggy (never opponents' — PIGGY_BANK is
          // already in HIDDEN_FROM_OPPONENTS and gated by powerups5 above) and
          // only when the snapshot is mintable (kill-switch guard mirrors
          // mintPiggyBank). Uses the SAME sumStepsInWindow the mint uses over
          // [startsAt, min(expiresAt, now)] so the shown number can only agree
          // with the eventual mint. At most one extra query, owner-only. A
          // thrown sum query omits the field — the progress payload must never
          // 500 because of a display counter.
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

    // Build leaderboard with stealth mode and detour sign applied. The
    // collection is shared with the tournament bracket payload via
    // collectRaceIllusions so the two surfaces mask identically.
    // IMPOSTER display swaps swap the DISPLAYED leaderboard slot of two users
    // for ALL viewers. Cosmetic only — never read by the settlement path.
    let stealthedUserIds = new Set();
    let viewerIsDetoured = false;
    let imposterSwaps = [];
    const nowTime = now();
    if (race.powerupsEnabled) {
      const activeEffects = await raceActiveEffectModel.findActiveForRace(raceId);
      ({ stealthedUserIds, viewerIsDetoured, imposterSwaps } =
        collectRaceIllusions(activeEffects, userId, nowTime.getTime()));
    }

    // §6a — per-participant CURRENT MULTIPLIER (additive; old clients ignore it).
    // Fold in any active global 2x event by multiplying the MAGNITUDE (sign
    // preserved, since the event multiplier is > 0): pepper(3)+RH(2)=5, ×2 = 10;
    // a frozen 0 stays 0; a wrong-turned −5 becomes −10. Neutral 1 under an event
    // reads as 2. LEECH (a transfer) never affects this.
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

    // §6b — evaluate the high-multiplier alert for every participant. This is the
    // recompute/re-arm path: it catches event-driven crossings and clears the flag
    // as buffs decay. The evaluator claims the emit atomically, so concurrent
    // viewers' polls can't double-fire. Best-effort — a push-eval failure must
    // never break the progress payload.
    if (race.powerupsEnabled) {
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

    // Items 12/16 — ONE server-authoritative placement. Computed from the
    // HONEST live totals (before Stealth masking and before the Imposter slot
    // swap) with the SHARED comparator that getRaces, getHomeRaceCard and
    // placementRecompute now also use, so the three surfaces stop disagreeing.
    // Additive + nullable: frozen clients ignore `placement`/`myPlacement` and
    // keep their own array-index sort.
    const placementByUserId = placementsByUserId(
      stepTotals.map(({ participant, totalSteps }) => ({
        userId: participant.userId,
        totalSteps,
        finishedAt: participant.finishedAt,
        placement: participant.placement,
        joinedAt: participant.joinedAt,
      }))
    );

    const leaderboard = stepTotals
      .map(({ participant, totalSteps }) => {
        // §6a — a masked row (detoured/stealthed opponent) must NOT leak the
        // player's multiplier (it would reveal a hidden buff/freeze), exactly like
        // its steps are nulled. currentMultiplier is null for masked rows, else
        // the event-inclusive signed value (1 => neutral; the client renders
        // nothing at 1/absent).
        const rawCurrentMultiplier =
          multiplierByParticipantId.get(participant.id) ?? 1;
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
            currentMultiplier: null,
            // Detour Sign masks every total, so it must mask every rank too —
            // otherwise the placement leaks exactly what the "???" hides.
            placement: null,
            // Team identity is structural (column grouping), never masked.
            team: participant.team ?? null,
            forfeitedAt: participant.forfeitedAt ?? null,
          };
        }
        const isStealthed = stealthedUserIds.has(participant.userId)
          && participant.userId !== userId
          && !participant.finishedAt;
        return {
          userId: participant.userId,
          displayName: isStealthed ? "???" : participant.user.displayName,
          profilePhotoUrl: isStealthed ? null : participant.user.profilePhotoUrl,
          ...(isStealthed
            ? { accessories: [], animal: null }
            : characterPresentation(participant.user, supportsCharacters, releaseChannel)),
          totalSteps: isStealthed ? null : totalSteps,
          finishedAt: participant.finishedAt,
          stealthed: isStealthed,
          // A stealthed rival's steps are nulled, so their rank must be too.
          placement: isStealthed
            ? null
            : placementByUserId.get(participant.userId) ?? null,
          currentMultiplier: isStealthed ? null : rawCurrentMultiplier,
          // Team races (TR-656): stealth masks the individual plank only; the
          // side (and the honest team totals below) stay visible.
          team: participant.team ?? null,
          forfeitedAt: participant.forfeitedAt ?? null,
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

    const updatedRace = await raceModel.findById(raceId);

    const result = {
      raceId: race.id,
      status: updatedRace.status,
      endsAt: race.endsAt,
      maxDurationDays: race.maxDurationDays,
      targetSteps: race.targetSteps, // 1.1.4 compat
      participants: leaderboard,
      // Items 12/16 — additive, nullable. `myPlacementHidden` mirrors the
      // GET /races semantics exactly so the client reads one rule on both.
      myPlacement: viewerIsDetoured
        ? null
        : placementByUserId.get(userId) ?? null,
      myPlacementHidden: viewerIsDetoured,
      ...tournamentFields(race),
    };

    // Team H2H block (TR-401), computed from TRUE totals before any display
    // illusion — always honest (TR-658). Additive; old clients ignore it.
    if (race.isTeamRace) {
      result.teams = buildTeamsBlock(race, stepTotals);
      result.winnerTeam = updatedRace.winnerTeam ?? null;
      result.isTeamRace = true;
      result.teamSize = race.teamSize ?? null;
    }

    // §5.3 — additive `dropOdds` so a player can see the exact odds they are
    // playing against. Derived from the SAME helpers the roll uses, and from the
    // SAME true step totals openMysteryBox ranks on (never the illusion-masked
    // leaderboard), so what is displayed matches what will actually be rolled.
    //
    // `configVersion` is included so a displayed number can be reconciled with a
    // roll after the fact — under pm2 cluster mode a roll seconds later may
    // legitimately use a newer config (§3.1: auditability, not prevention).
    if (powerupData && balanceConfigSnapshot) {
      const dropOdds = buildDropOdds({
        race,
        userId,
        stepTotals,
        myParticipant,
        snapshot: balanceConfigSnapshot,
        supportsPowerups5,
      });
      if (dropOdds) powerupData.dropOdds = dropOdds;
    }

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
