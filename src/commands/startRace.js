const { Race } = require("../models/race");
const { RaceParticipant } = require("../models/raceParticipant");
const { RacePowerupEvent } = require("../models/racePowerupEvent");
const { Steps } = require("../models/steps");
const { eventBus } = require("../events/eventBus");
const { isRacePayoutPresetCompatible } = require("../utils/racePayoutPresets");

const { acceptedTeamCounts } = require("../utils/teamRaces");

class RaceStartError extends Error {
  constructor(message, statusCode, code) {
    super(message);
    this.name = "RaceStartError";
    if (statusCode) this.statusCode = statusCode;
    // Optional machine-readable code (TEAMS_UNEVEN). Additive.
    if (code) this.code = code;
  }
}

function buildStartRace(dependencies = {}) {
  const raceModel = dependencies.Race || Race;
  const participantModel = dependencies.RaceParticipant || RaceParticipant;
  const stepsModel = dependencies.Steps || Steps;
  const eventModel = dependencies.RacePowerupEvent || RacePowerupEvent;
  const events = dependencies.eventBus || eventBus;
  const now = dependencies.now || (() => new Date());

  // 1.1.7: `bypassSchedule` lets the autoStartScheduledRaces cron job start a
  // scheduled race at the scheduled moment (it pins `now` to scheduledStartAt so
  // endsAt anchors there). `now` is also injectable for that anchoring + tests.
  return async function startRace({ userId, raceId, bypassSchedule = false, now: nowOverride }) {
    const startNow = typeof nowOverride === "function" ? nowOverride : now;
    const race = await raceModel.findById(raceId);
    if (!race) {
      throw new RaceStartError("Race not found", 404);
    }
    if (race.creatorId !== userId) {
      throw new RaceStartError("Only the race creator can start the race", 403);
    }
    if (race.status !== "PENDING") {
      throw new RaceStartError("Race has already been started or is no longer active", 400);
    }

    // 1.1.7: block early manual start of a scheduled race. Applies to ALL
    // clients — old apps that still render a Start button on a scheduled PENDING
    // race get a clean rejection instead of starting it early. The cron job
    // passes bypassSchedule (the schedule is already satisfied by then).
    if (!bypassSchedule && race.scheduledStartAt) {
      const scheduled = new Date(race.scheduledStartAt);
      if (
        !Number.isNaN(scheduled.getTime()) &&
        scheduled.getTime() > startNow().getTime()
      ) {
        throw new RaceStartError(
          "This race is scheduled to start later and can't be started early",
          400
        );
      }
    }

    const acceptedCount = await participantModel.countAccepted(raceId);
    if (acceptedCount < 2) {
      throw new RaceStartError("At least 2 accepted participants are required to start", 400);
    }

    // Team races (TR-301/302/303): both sides must be EQUAL and >= 1 among
    // ACCEPTED participants. The configured teamSize is a cap, not a minimum —
    // a 3v3-configured race may start 2v2. INVITED rows never count (they are
    // dropped at start exactly as in individual races).
    if (race.isTeamRace) {
      const counts = acceptedTeamCounts(race.participants || []);
      if (
        counts.TEAM_A < 1 ||
        counts.TEAM_B < 1 ||
        counts.TEAM_A !== counts.TEAM_B
      ) {
        throw new RaceStartError(
          `Teams must be even to start — currently ${counts.TEAM_A}v${counts.TEAM_B}`,
          409,
          "TEAMS_UNEVEN"
        );
      }
    }

    if (
      !isRacePayoutPresetCompatible({
        preset: race.payoutPreset || "WINNER_TAKES_ALL",
        acceptedCount,
      })
    ) {
      throw new RaceStartError(
        "This payout mode only supports races with at least 4 accepted participants",
        400
      );
    }

    const startedAt = startNow();
    const durationDays = race.maxDurationDays || 7;
    const endsAt = new Date(
      startedAt.getTime() + durationDays * 24 * 60 * 60 * 1000
    );
    const acceptedParticipants = await participantModel.findAcceptedByRace(raceId);
    const heldPot = acceptedParticipants.reduce((sum, participant) => {
      if ((participant.buyInStatus || "NONE") === "HELD") {
        return sum + (participant.buyInAmount || 0);
      }
      return sum;
    }, 0);

    // Conditional flip: claim the PENDING -> ACTIVE transition. The status check
    // at line 36 is a read (TOCTOU) — two concurrent starters (manual Start vs the
    // auto-start cron, or two server instances) can both pass it. Only the runner
    // whose updateMany matches a still-PENDING row (count === 1) proceeds to
    // snapshot participants and emit RACE_STARTED; the loser returns the now-ACTIVE
    // race without double-notifying.
    const flip = await raceModel.updateIfPending(raceId, {
      status: "ACTIVE",
      startedAt,
      endsAt,
      potCoins: (race.potCoins || 0) + heldPot,
    });
    if (flip.count === 0) {
      return raceModel.findById(raceId);
    }

    // Snapshot each participant's current steps so only post-race steps count
    const today = startedAt.toISOString().slice(0, 10);
    for (const p of acceptedParticipants) {
      const todaySteps = await stepsModel.findByUserIdAndDate(p.userId, today);
      const updateFields = {
        baselineSteps: todaySteps?.steps ?? 0,
        joinedAt: startedAt,
      };
      // Initialize powerup thresholds if powerups are enabled
      if (race.powerupsEnabled && race.powerupStepInterval) {
        updateFields.nextBoxAtSteps = race.powerupStepInterval;
      }
      if ((p.buyInAmount || 0) > 0 && p.buyInStatus === "HELD") {
        updateFields.buyInStatus = "COMMITTED";
      }
      await participantModel.update(p.id, updateFields);
    }

    const participantUserIds = acceptedParticipants.map((p) => p.userId);

    await eventModel.create({
      raceId,
      actorUserId: userId,
      eventType: "RACE_STARTED",
      description: "Race started!",
    });

    events.emit("RACE_STARTED", {
      raceId,
      raceName: race.name,
      creatorUserId: userId,
      participantUserIds,
      // TR-684: the push handler frames team races as "A vs B".
      isTeamRace: race.isTeamRace === true,
      teamAName: race.teamAName ?? null,
      teamBName: race.teamBName ?? null,
    });

    return raceModel.findById(raceId);
  };
}

const startRace = buildStartRace();

module.exports = { buildStartRace, startRace, RaceStartError };
