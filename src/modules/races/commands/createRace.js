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
} = require("../services/validateRaceConfig");
const { appSettings } = require("../../../shared/config/appSettings");
const {
  generateTeamNamePair: defaultGenerateTeamNamePair,
} = require("../constants/teamNames");
const { resolveTeamPoolMultBps } = require("../teamPoolMultiplier");

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

  return async function createRace({
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
  }) {
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

    const race = await raceModel.create({
      creatorId: userId,
      name: name.trim(),
      // 1.1.4 compat: persist whatever targetSteps the legacy client sent so it
      // can render its own UI. Display-only — see the note in the signature.
      targetSteps: Number.isFinite(targetSteps) && targetSteps > 0 ? targetSteps : 0,
      maxDurationDays,
      powerupsEnabled: !!powerupsEnabled,
      powerupStepInterval: normalizedPowerupStepInterval,
      buyInAmount: buyInConfig.buyInAmount,
      payoutPreset: buyInConfig.payoutPreset,
      // The row-level discriminator: this race's prize is app-minted, and stays
      // app-minted even if the flag is flipped back off mid-race.
      fundedPrize: fundedPrizePools === true,
      isPublic: !!isPublic,
      maxParticipants: normalizedMaxParticipants,
      scheduledStartAt: normalizedScheduledStartAt,
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
      teamPoolMultBps: resolveTeamPoolMultBps({
        isTeamRace: !!teamConfig,
        durationDays: maxDurationDays,
      }),
    });

    await participantModel.create({
      raceId: race.id,
      userId,
      status: "ACCEPTED",
      buyInAmount: buyInConfig.buyInAmount,
      buyInStatus: buyInConfig.buyInAmount > 0 ? "HELD" : "NONE",
      // TR-104: creator's chosen side (TEAM_A default) on team races.
      team: teamConfig ? teamConfig.creatorTeam : null,
    });

    await reserveRaceBuyIn({
      awardCoinsFn: holdCoinsFn,
      userId,
      raceId: race.id,
      amount: buyInConfig.buyInAmount,
    });

    const fullRace = await raceModel.findById(race.id);

    events.emit("RACE_CREATED", {
      raceId: race.id,
      creatorUserId: userId,
    });

    return fullRace;
  };
}

const createRace = buildCreateRace();

module.exports = { buildCreateRace, createRace, RaceCreationError };
