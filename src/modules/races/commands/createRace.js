const { Race } = require("../models/race");
const { RaceParticipant } = require("../models/raceParticipant");
const { User } = require("../../users");
const { awardCoins } = require("../../../shared/economy/awardCoins");
const { eventBus } = require("../../../shared/events/eventBus");
const {
  buildAtomicHoldFn,
  ensureUserCanAfford,
  reserveRaceBuyIn,
} = require("../services/raceBuyIns");
const {
  validateRaceName,
  validateDuration,
  normalizePowerupConfig,
  validateMaxParticipants,
  validateRaceBuyInConfig,
  validateTeamName,
  validateTeamSize,
  assertTeamNamesDiffer,
  validateTeamSide,
  parseScheduledEndAt,
  validateRaceWindow,
  durationDaysFromWindow,
} = require("../services/validateRaceConfig");
const { appSettings } = require("../../../shared/config/appSettings");
const {
  generateTeamNamePair: defaultGenerateTeamNamePair,
} = require("../constants/teamNames");
const { resolveTeamPoolMultBps } = require("../teamPoolMultiplier");
const {
  computeRaceExposureStamp,
  newRacePrizeStamp,
  reserveFundedExposure,
  lockFundedExposureUsers,
} = require("../services/fundedExposure");
const {
  prisma: defaultPrisma,
  deferUntilAfterCommit,
  runInPrismaTransaction,
} = require("../../../db");
const {
  supportsNextRace,
  hasAnyQuickMetadata,
  isSupportedQuickConfig,
  hasLiveUserCreatedRace,
  QUICK_SOURCE,
  AUTO_START_POLICY,
} = require("../services/nextRacePolicy");
const { acquireRaceWriteFence } = require("../services/raceWriteFence");
const {
  recordReferralRaceActivity: defaultRecordReferralRaceActivity,
} = require("../../social/commands/recordReferralRaceActivity");
const {
  newTeamPayoutStamp,
} = require("../services/teamWinnerReward");

class RaceCreationError extends Error {
  constructor(message, statusCode, code) {
    super(message);
    this.name = "RaceCreationError";
    if (statusCode) this.statusCode = statusCode;
    // Optional machine-readable error code (additive — old clients only read
    // `error`; new clients branch on `code`, e.g. TEAM_NAMES_IDENTICAL).
    if (code) this.code = code;
  }
}

// 1.1.7: normalize an optional scheduledStartAt. Returns a Date in the future,
// or null when not provided / unparseable. Throws only when a parseable value
// is in the PAST — that's a clear user error (a date picker that returned a
// stale time). An unparseable value is treated as "not provided" so an older or
// quirky client can never have a race silently rejected for sending junk.
function validateScheduledStartAt(value, ErrorClass, nowFn = () => new Date()) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  if (parsed.getTime() <= nowFn().getTime()) {
    throw new ErrorClass("Scheduled start time must be in the future", 400);
  }
  return parsed;
}

// Canonical tz for a user-created race: the creator's device tz, validated as a
// real IANA zone. Persisting it makes the live cron, the display path, and
// settlement bucket steps by the SAME calendar days (raceTimeZone reads it),
// closing the "you slipped to 2nd, but I'm still 1st" divergence. Returns null
// for a missing/unparseable tz so legacy behavior (caller-tz live, UTC settle)
// is preserved rather than persisting garbage.
function normalizeRaceTimeZone(value) {
  if (!value || typeof value !== "string") return null;
  try {
    Intl.DateTimeFormat("en-US", { timeZone: value });
    return value;
  } catch {
    return null;
  }
}

function buildCreateRace(dependencies = {}) {
  const raceModel = dependencies.Race || Race;
  const participantModel = dependencies.RaceParticipant || RaceParticipant;
  const userModel = dependencies.User || User;
  const awardCoinsFn = dependencies.awardCoins || awardCoins;
  // Holds use the balance-guarded atomic debit (ensureUserCanAfford is only a
  // fast-fail pre-check); an injected awardCoins fake still takes both roles.
  // No code arg: this site's ensureUserCanAfford throws code-less, keep parity.
  const holdCoinsFn =
    dependencies.awardCoins ||
    buildAtomicHoldFn({ ErrorClass: RaceCreationError });
  const events = dependencies.eventBus || eventBus;
  const settings = dependencies.appSettings || appSettings;
  const generateTeamNamePair =
    dependencies.generateTeamNamePair || defaultGenerateTeamNamePair;
  const usesDefaultPersistence =
    !dependencies.Race &&
    !dependencies.RaceParticipant &&
    !dependencies.User &&
    !dependencies.prisma;
  const recordReferralRaceActivity = Object.prototype.hasOwnProperty.call(
    dependencies,
    "recordReferralRaceActivity",
  )
    ? dependencies.recordReferralRaceActivity
    : Object.keys(dependencies).length > 0
      ? async () => null
      : defaultRecordReferralRaceActivity;

  const createRaceCore = async function createRace({
    userId,
    name,
    maxDurationDays = 7,
    powerupsEnabled = false,
    powerupStepInterval,
    buyInAmount = 0,
    payoutPreset,
    isPublic = false,
    maxParticipants = 10,
    // 1.1.7: optional future auto-start time. Older clients never send it, so it
    // stays null and the race behaves exactly as today (manual instant start).
    scheduledStartAt = null,
    // Custom race window (spec §5.2). An EXACT end instant. Optional and
    // additive: frozen clients never send it, so it stays null and the race
    // ends at startedAt + maxDurationDays × 24h exactly as today. Gated by the
    // customRaceWindowEnabled flag (403 FEATURE_DISABLED while off, never a
    // silent drop) and, when accepted, it OVERWRITES the client's
    // maxDurationDays with the floor-derived day count (§5.3).
    scheduledEndAt = null,
    // 1.1.4 compat: legacy clients still send targetSteps on createRace. New
    // clients don't, in which case it stays 0. TR-903 keeps accepting, storing
    // and returning it so a frozen old binary can still render the target it
    // picked — but it is DISPLAY-ONLY: no race completes on reaching it
    // (TR-902 removed that path; every race is time-based).
    targetSteps = 0,
    // The creator's device tz (req.timeZone). Stored as the race's canonical tz
    // so live standings and notifications agree for every viewer. Older callers
    // that omit it leave timezone NULL — unchanged legacy behavior.
    timeZone = null,
    // ── Team races (TR-100s) ─────────────────────────────────────────────────
    // Only clients that send the `team_races` X-Client-Features token can set
    // isTeamRace (TR-106). Older clients never send any of these.
    isTeamRace = false,
    teamSize = null,
    teamAName = null,
    teamBName = null,
    // Creator's side (TR-104); defaults to TEAM_A.
    team = null,
    // The requester's resolved X-Client-Features tokens (array or Set).
    clientFeatures = null,
    creationSource = null,
    startPolicy = null,
  }) {
    const capable = supportsNextRace(
      clientFeatures instanceof Set ? clientFeatures : new Set(clientFeatures || [])
    );
    const quickInput = {
      creationSource,
      startPolicy,
      maxDurationDays,
      isPublic,
      buyInAmount,
      payoutPreset,
      powerupsEnabled,
      powerupStepInterval,
      maxParticipants,
      isTeamRace,
    };
    const requestedQuickMetadata = hasAnyQuickMetadata(quickInput);
    if (capable && requestedQuickMetadata && !isSupportedQuickConfig(quickInput)) {
      throw new RaceCreationError(
        "This quick-race configuration is not supported.",
        400,
        "INVALID_QUICK_CREATE_CONFIG"
      );
    }
    const normalizedQuick = capable && isSupportedQuickConfig(quickInput);
    if (normalizedQuick) {
      const enabled = await settings.getFlag("quickCreateRaceCtaEnabled");
      if (!enabled) {
        throw new RaceCreationError(
          "Quick create is temporarily unavailable.",
          503,
          "QUICK_CREATE_DISABLED"
        );
      }
      if (await hasLiveUserCreatedRace(userId)) {
        throw new RaceCreationError(
          "Finish or leave your current race before starting another.",
          409,
          "QUICK_RACE_ALREADY_LIVE"
        );
      }
    }
    validateRaceName(name, RaceCreationError);
    validateDuration(maxDurationDays, RaceCreationError);

    let teamConfig = null;
    if (isTeamRace) {
      // TR-106 (defensive): only feature-token clients may create team races.
      const features =
        clientFeatures instanceof Set
          ? clientFeatures
          : new Set(clientFeatures || []);
      if (!features.has("team_races")) {
        throw new RaceCreationError(
          "Update the app to create team races",
          400,
          "UPDATE_REQUIRED"
        );
      }

      // TR-107: remote kill switch blocks NEW team-race creation only.
      const enabled = await settings.getFlag("teamRacesEnabled");
      if (!enabled) {
        throw new RaceCreationError(
          "Team races are temporarily disabled",
          403,
          "FEATURE_DISABLED"
        );
      }

      const normalizedTeamSize = validateTeamSize(teamSize, RaceCreationError);
      const aOverridden = teamAName !== null && teamAName !== undefined;
      const bOverridden = teamBName !== null && teamBName !== undefined;
      const [generatedA, generatedB] = generateTeamNamePair();
      let finalTeamAName = aOverridden
        ? validateTeamName(teamAName, RaceCreationError, "Team A name")
        : generatedA;
      let finalTeamBName = bOverridden
        ? validateTeamName(teamBName, RaceCreationError, "Team B name")
        : generatedB;
      if (
        finalTeamAName.toLowerCase() === finalTeamBName.toLowerCase() &&
        !(aOverridden && bOverridden)
      ) {
        // A single creator override collided with the server-generated other
        // side — not the creator's fault; re-roll the generated side until the
        // pair differs (TEAM_NAMES_IDENTICAL is reserved for creator-vs-creator
        // collisions).
        for (let i = 0; i < 20; i++) {
          const [nextA, nextB] = generateTeamNamePair();
          if (aOverridden && nextB.toLowerCase() !== finalTeamAName.toLowerCase()) {
            finalTeamBName = nextB;
            break;
          }
          if (!aOverridden && nextA.toLowerCase() !== finalTeamBName.toLowerCase()) {
            finalTeamAName = nextA;
            break;
          }
        }
      }
      assertTeamNamesDiffer(finalTeamAName, finalTeamBName, RaceCreationError);
      const creatorTeam = validateTeamSide(team, RaceCreationError);

      teamConfig = {
        teamSize: normalizedTeamSize,
        teamAName: finalTeamAName,
        teamBName: finalTeamBName,
        creatorTeam,
      };
    }
    const normalizedScheduledStartAt = validateScheduledStartAt(
      scheduledStartAt,
      RaceCreationError
    );

    // ── Custom race window (spec §5.2, §5.2a, §5.3) ──────────────────────────
    // Unparseable => null => this whole block is a no-op and the race is a
    // plain preset race, which is exactly what every frozen client creates.
    const normalizedScheduledEndAt = parseScheduledEndAt(scheduledEndAt);
    // Derived AFTER the quick-config check and validateDuration and BEFORE
    // raceModel.create (architect R5): maxDurationDays is not only the
    // prize-pool input, it is also what resolveTeamPoolMultBps stamps into
    // teamPoolMultBps — a creation-time economy value SETTLEMENT reads back. If
    // the persisted duration and the pool multiplier came from different
    // numbers, a team custom race would settle against a multiplier for a
    // duration it never had.
    let effectiveMaxDurationDays = maxDurationDays;
    if (normalizedScheduledEndAt) {
      const customWindowEnabled = await settings.getFlag(
        "customRaceWindowEnabled"
      );
      if (!customWindowEnabled) {
        throw new RaceCreationError(
          "Custom race windows are temporarily unavailable",
          403,
          "FEATURE_DISABLED"
        );
      }
      // "Effective start" = scheduledStartAt when set, else now.
      const effectiveStart = normalizedScheduledStartAt || new Date();
      validateRaceWindow({
        effectiveStart,
        scheduledEndAt: normalizedScheduledEndAt,
        ErrorClass: RaceCreationError,
      });
      effectiveMaxDurationDays = durationDaysFromWindow(
        effectiveStart,
        normalizedScheduledEndAt
      );
    }
    // The interval is server-decided (2,000 always). A frozen client's
    // powerupStepInterval is accepted and IGNORED — never a 400.
    const normalizedPowerupStepInterval = normalizePowerupConfig({
      powerupsEnabled,
    });
    // null => unlimited (no cap). Older clients omit the field; the destructure
    // default of 10 keeps their behaviour. New clients may send explicit null.
    // Team races ignore the client's value: the field cap is always 2×teamSize
    // (TR-101).
    const normalizedMaxParticipants = teamConfig
      ? teamConfig.teamSize * 2
      : validateMaxParticipants(maxParticipants, RaceCreationError);

    // App-funded prize pools: while the flag is on, entry is FREE. A frozen
    // client's buyInAmount/buyInEnabled are accepted and IGNORED (coerced to 0)
    // — never a 400, or every un-updated binary loses the ability to create a
    // race. Coerced BEFORE validation so even an off-band legacy amount (below
    // the old 10-coin minimum) still creates cleanly.
    const fundedPrizePools = await settings.getFlag("fundedPrizePoolsEnabled");
    const payoutRoundingV1Enabled = await settings.getFlag(
      "payoutRoundingV1Enabled",
    );
    // Same creation-time stamping rule as fundedPrize: this setting controls
    // only future races. An in-flight race's capabilities never reprice when a
    // remote flag flips during a phased app rollout.
    const exitActionsEnabled = await settings.getFlag("raceExitActionsEnabled");
    const requestedBuyIn = fundedPrizePools ? 0 : buyInAmount;

    const buyInConfig = validateRaceBuyInConfig({
      buyInAmount: requestedBuyIn,
      // TR-102: payoutPreset is ignored for team races (team pot rules apply);
      // store WINNER_TAKES_ALL for display compat on old clients.
      payoutPreset: teamConfig ? "WINNER_TAKES_ALL" : payoutPreset,
      ErrorClass: RaceCreationError,
    });

    await ensureUserCanAfford({
      userModel,
      userId,
      amount: buyInConfig.buyInAmount,
      ErrorClass: RaceCreationError,
    });

    const teamPoolMultBps = resolveTeamPoolMultBps({
      isTeamRace: !!teamConfig,
      durationDays: effectiveMaxDurationDays,
    });
    const teamPayoutStamp = newTeamPayoutStamp({
      fundedPrize: fundedPrizePools === true,
      isTeamRace: !!teamConfig,
      durationDays: effectiveMaxDurationDays,
    });
    const prizeStamp = newRacePrizeStamp();
    const fundedExposureStamp = computeRaceExposureStamp({
      maxDurationDays: effectiveMaxDurationDays,
      prizeCoinUnit: prizeStamp.prizeCoinUnit,
      teamPoolMultBps,
    });
    if (usesDefaultPersistence) {
      await lockFundedExposureUsers(defaultPrisma, [userId]);
    }
    if (fundedPrizePools === true && usesDefaultPersistence) {
      await reserveFundedExposure({
        tx: defaultPrisma,
        userId,
        stamp: fundedExposureStamp,
        // Coin/rate limits remain retired. The permanent five-membership cap
        // is enforced independently across user-created races/tournaments.
        enforceLimits: false,
        enforceMembershipLimit: true,
      });
    }

    const race = await raceModel.create({
      creatorId: userId,
      name: name.trim(),
      // 1.1.4 compat: persist whatever targetSteps the legacy client sent so it
      // can render its own UI. Display-only — see the note in the signature.
      targetSteps: Number.isFinite(targetSteps) && targetSteps > 0 ? targetSteps : 0,
      // §5.3: when a custom window is accepted the SERVER owns this number —
      // the client's value is overwritten with the floor-derived day count so
      // the plaque, the persisted race and the payout can never disagree.
      maxDurationDays: effectiveMaxDurationDays,
      powerupsEnabled: !!powerupsEnabled,
      powerupStepInterval: normalizedPowerupStepInterval,
      buyInAmount: buyInConfig.buyInAmount,
      payoutPreset: buyInConfig.payoutPreset,
      // The row-level discriminator: this race's prize is app-minted, and stays
      // app-minted even if the flag is flipped back off mid-race.
      fundedPrize: fundedPrizePools === true,
      prizeCalculationVersion: prizeStamp.prizeCalculationVersion,
      prizeCoinUnit:
        prizeStamp.prizeCalculationVersion >= 2
          ? prizeStamp.prizeCoinUnit
          : null,
      prizePoolMaxCoins:
        prizeStamp.prizeCalculationVersion >= 2
          ? prizeStamp.prizePoolMaxCoins
          : null,
      payoutRoundingVersion: fundedPrizePools === true && payoutRoundingV1Enabled === true ? 1 : 0,
      exitActionsEnabled: exitActionsEnabled === true,
      isPublic: !!isPublic,
      maxParticipants: normalizedMaxParticipants,
      scheduledStartAt: normalizedScheduledStartAt,
      scheduledEndAt: normalizedScheduledEndAt,
      timezone: normalizeRaceTimeZone(timeZone),
      // Team races are time-based ONLY (TR-401): they settle at endsAt via
      // raceExpiry and must never finish on a step target. Individual races
      // keep the schema default (false), so a legacy client's targetSteps
      // still target-finishes them (see the targetSteps note above).
      // TR-902: every race is time-based. Completion is owned solely by
      // ends_at (src/jobs/raceExpiry.js) — and, for team races, the collapse
      // path in commands/forfeitRace.js. targetSteps is persisted for legacy
      // client display only (TR-903) and completes nothing.
      timeBased: true,
      // TR-101/103/104: team-race fields (all null/false for individual races).
      isTeamRace: !!teamConfig,
      teamSize: teamConfig ? teamConfig.teamSize : null,
      teamAName: teamConfig ? teamConfig.teamAName : null,
      teamBName: teamConfig ? teamConfig.teamBName : null,
      // Item 5 (2026-08-08): stamp the team payout buff ONCE, here, from env.
      // Individual races stamp NULL (= 1.0). Read back by every projection and
      // by settlement, so an env retune never reprices an in-flight race.
      teamPoolMultBps,
      ...teamPayoutStamp,
      creationSource: normalizedQuick ? QUICK_SOURCE : null,
      startPolicy: normalizedQuick ? AUTO_START_POLICY : null,
    });

    // The row is still invisible inside this creation transaction, so no
    // competing writer can know its id yet. Establish C0 before the first
    // participant row so every post-commit membership/lifecycle path has the
    // same durable fence from birth.
    if (usesDefaultPersistence) {
      await acquireRaceWriteFence(defaultPrisma, race.id);
    }

    const creatorParticipant = await participantModel.create({
      raceId: race.id,
      userId,
      status: "ACCEPTED",
      buyInAmount: buyInConfig.buyInAmount,
      buyInStatus: buyInConfig.buyInAmount > 0 ? "HELD" : "NONE",
      // TR-104: creator's chosen side (TEAM_A default) on team races.
      team: teamConfig ? teamConfig.creatorTeam : null,
      ...(fundedPrizePools === true
        ? {
            fundedExposureMillicoins:
              fundedExposureStamp.exposureMillicoins,
            fundedExposureRateMillicoinsPerDay:
              fundedExposureStamp.exposureRateMillicoinsPerDay,
          }
        : {}),
    });

    await recordReferralRaceActivity({
      tx: dependencies.prisma || defaultPrisma,
      raceParticipantId: creatorParticipant.id,
      refereeId: userId,
      occurredAt: creatorParticipant.joinedAt || new Date(),
    });

    await reserveRaceBuyIn({
      awardCoinsFn: holdCoinsFn,
      userId,
      raceId: race.id,
      amount: buyInConfig.buyInAmount,
    });

    await deferUntilAfterCommit(() =>
      events.emit("RACE_CREATED", {
        raceId: race.id,
        creatorUserId: userId,
      })
    );

    return usesDefaultPersistence
      ? { id: race.id }
      : raceModel.findById(race.id);
  };

  return async function createRace(args) {
    if (!usesDefaultPersistence) return createRaceCore(args);
    const durable = await runInPrismaTransaction(() => createRaceCore(args), {
      maxWait: 5_000,
      timeout: 30_000,
    });
    return raceModel.findById(durable.id);
  };
}

const createRace = buildCreateRace();

module.exports = { buildCreateRace, createRace, RaceCreationError };
