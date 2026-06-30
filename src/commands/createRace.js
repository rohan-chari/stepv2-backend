const { Race } = require("../models/race");
const { RaceParticipant } = require("../models/raceParticipant");
const { User } = require("../models/user");
const { awardCoins } = require("./awardCoins");
const { eventBus } = require("../events/eventBus");
const {
  ensureUserCanAfford,
  reserveRaceBuyIn,
} = require("../services/raceBuyIns");
const {
  validateRaceName,
  validateDuration,
  validatePowerupConfig,
  validateMaxParticipants,
  validateRaceBuyInConfig,
} = require("../services/validateRaceConfig");

class RaceCreationError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = "RaceCreationError";
    if (statusCode) this.statusCode = statusCode;
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
  const events = dependencies.eventBus || eventBus;

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
    // clients don't, in which case it stays 0. The value isn't used by the
    // backend for completion logic (time-based only) — kept solely so the
    // legacy UI can render the target it picked.
    targetSteps = 0,
    // The creator's device tz (req.timeZone). Stored as the race's canonical tz
    // so live standings and notifications agree for every viewer. Older callers
    // that omit it leave timezone NULL — unchanged legacy behavior.
    timeZone = null,
  }) {
    validateRaceName(name, RaceCreationError);
    validateDuration(maxDurationDays, RaceCreationError);
    const normalizedScheduledStartAt = validateScheduledStartAt(
      scheduledStartAt,
      RaceCreationError
    );
    validatePowerupConfig({
      powerupsEnabled,
      powerupStepInterval,
      ErrorClass: RaceCreationError,
    });
    // null => unlimited (no cap). Older clients omit the field; the destructure
    // default of 10 keeps their behaviour. New clients may send explicit null.
    const normalizedMaxParticipants = validateMaxParticipants(
      maxParticipants,
      RaceCreationError
    );

    const buyInConfig = validateRaceBuyInConfig({
      buyInAmount,
      payoutPreset,
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
      // can render its own UI. Not used for completion (time-based only).
      targetSteps: Number.isFinite(targetSteps) && targetSteps > 0 ? targetSteps : 0,
      maxDurationDays,
      powerupsEnabled: !!powerupsEnabled,
      powerupStepInterval: powerupsEnabled ? powerupStepInterval : null,
      buyInAmount: buyInConfig.buyInAmount,
      payoutPreset: buyInConfig.payoutPreset,
      isPublic: !!isPublic,
      maxParticipants: normalizedMaxParticipants,
      scheduledStartAt: normalizedScheduledStartAt,
      timezone: normalizeRaceTimeZone(timeZone),
    });

    await participantModel.create({
      raceId: race.id,
      userId,
      status: "ACCEPTED",
      buyInAmount: buyInConfig.buyInAmount,
      buyInStatus: buyInConfig.buyInAmount > 0 ? "HELD" : "NONE",
    });

    await reserveRaceBuyIn({
      awardCoinsFn,
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
