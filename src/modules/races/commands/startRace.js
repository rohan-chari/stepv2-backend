const { Race } = require("../models/race");
const { RaceParticipant } = require("../models/raceParticipant");
const { RacePowerupEvent } = require("../../powerups/models/racePowerupEvent");
const { Steps } = require("../../steps/models/steps");
const { eventBus } = require("../../../shared/events/eventBus");
const { isRacePayoutPresetCompatible } = require("../racePayoutPresets");

const { acceptedTeamCounts } = require("../teamRaces");
const { snapshotBaselineFields } = require("../services/raceBaseline");
const { commitRaceStart } = require("../services/commitRaceStart");
const { resolveRaceEndsAt } = require("../services/resolveRaceEndsAt");
const {
  durationDaysFromWindow,
} = require("../services/validateRaceConfig");
const { resolveTeamPoolMultBps } = require("../teamPoolMultiplier");
const {
  enqueueRaceResolution: defaultEnqueueRaceResolution,
} = require("../services/enqueueRaceResolution");

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
  const commitRaceStartFn = dependencies.commitRaceStart || commitRaceStart;
  const beforeCommitRaceStart = dependencies.beforeCommitRaceStart;
  const beforeRaceStartedRecord = dependencies.beforeRaceStartedRecord;
  const enqueueRaceResolution = Object.prototype.hasOwnProperty.call(
    dependencies,
    "enqueueRaceResolution"
  )
    ? dependencies.enqueueRaceResolution
    : Object.keys(dependencies).length > 0
      ? async () => null
      : defaultEnqueueRaceResolution;
  const now = dependencies.now || (() => new Date());
  const useDurableStart =
    !dependencies.Race &&
    !dependencies.RaceParticipant &&
    !dependencies.Steps &&
    !dependencies.RacePowerupEvent;

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
          `Teams must be even to start. Currently ${counts.TEAM_A}v${counts.TEAM_B}`,
          409,
          "TEAMS_UNEVEN"
        );
      }
    }

    const quickTwoPersonTop3 =
      race.creationSource === "QUICK_CREATE" &&
      race.startPolicy === "ON_MINIMUM_PARTICIPANTS" &&
      race.payoutPreset === "TOP3_70_20_10" &&
      acceptedCount >= 2;
    if (
      !quickTwoPersonTop3 &&
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
    // Legacy end: startedAt + N × 24h. Still the answer for every race without
    // a custom window, which is every race that exists today (spec §5.4).
    const fallbackEndsAt = new Date(
      startedAt.getTime() + durationDays * 24 * 60 * 60 * 1000
    );
    const { endsAt, honoredCustomEnd } = resolveRaceEndsAt({
      race,
      startedAt,
      fallbackEndsAt,
    });
    // §5.3a — THE anti-exploit rule. Today "priced duration == elapsed
    // duration" holds BY CONSTRUCTION, because endsAt is derived from
    // maxDurationDays. A stamped end instant breaks that: the price was derived
    // at CREATE time from the effective start, while the honored end is
    // measured against whatever startedAt turns out to be. A public race
    // (no auto-start, never pruned) created with a 30-day window and started
    // with 24h left would otherwise pay a 30-day pool — 8x — for a one-day
    // race, unbounded by any rate limit and needing one step per colluder.
    // Re-deriving here, inside the SAME PENDING->ACTIVE CAS write, restores
    // priced == elapsed by construction and makes the feature's economy delta
    // exactly zero.
    const pricedDurationDays = honoredCustomEnd
      ? durationDaysFromWindow(startedAt, endsAt)
      : null;
    // maxDurationDays is NOT the only economy value derived from the duration:
    // teamPoolMultBps was stamped at CREATE from the create-time duration and
    // settlement reads it back verbatim (racePrizePool -> raceTeamPoolMultBps).
    // Re-pricing the duration without re-stamping the multiplier is exactly the
    // divergence architect R5 named — a team race whose teams stay uneven until
    // day 29 of a 30-day window would re-price to 1 day while keeping the
    // 1.875x long-race buff, minting 37.5 coins/player-day against the stated
    // ceiling of 20. Both values move in the SAME write or neither does.
    const pricedTeamPoolMultBps =
      pricedDurationDays != null && race.isTeamRace === true
        ? resolveTeamPoolMultBps({
            isTeamRace: true,
            durationDays: pricedDurationDays,
          })
        : null;
    const startFields =
      pricedDurationDays != null
        ? {
            maxDurationDays: pricedDurationDays,
            ...(pricedTeamPoolMultBps != null
              ? { teamPoolMultBps: pricedTeamPoolMultBps }
              : {}),
          }
        : {};
    const acceptedParticipants = await participantModel.findAcceptedByRace(raceId);
    const heldPot = acceptedParticipants.reduce((sum, participant) => {
      if ((participant.buyInStatus || "NONE") === "HELD") {
        return sum + (participant.buyInAmount || 0);
      }
      return sum;
    }, 0);

    if (useDurableStart) {
      const participantUpdates = [];
      for (const participant of [...acceptedParticipants].sort((a, b) =>
        a.userId.localeCompare(b.userId)
      )) {
        const fields = await snapshotBaselineFields({
          participant,
          race,
          startedAt,
          stepsModel,
        });
        if ((participant.buyInAmount || 0) > 0 && participant.buyInStatus === "HELD") {
          fields.buyInStatus = "COMMITTED";
        }
        participantUpdates.push({
          id: participant.id,
          userId: participant.userId,
          fields,
        });
      }
      if (beforeCommitRaceStart) {
        await beforeCommitRaceStart({ raceId, participantUpdates });
      }
      const committed = await commitRaceStartFn({
        raceId,
        actorUserId: userId,
        startedAt,
        endsAt,
        // §5.3a: re-priced duration AND the team multiplier derived from it,
        // written in the same CAS write as the status flip (null => untouched,
        // the legacy path).
        maxDurationDays: pricedDurationDays,
        teamPoolMultBps: pricedTeamPoolMultBps,
        potCoins: (race.potCoins || 0) + heldPot,
        participantUpdates,
        beforeRaceStartedRecord,
      });
      if (committed.participantChanged) {
        // A join committed while baselines were being read. Retry from a fresh
        // race/participant snapshot; the first transaction wrote nothing.
        return startRace({ userId, raceId, bypassSchedule, now: nowOverride });
      }
      if (!committed.started) return raceModel.findById(raceId);

      const participantUserIds = participantUpdates.map((p) => p.userId);
      events.emit("RACE_STARTED", {
        raceId,
        raceName: race.name,
        creatorUserId: userId,
        participantUserIds,
        isTeamRace: race.isTeamRace === true,
        teamAName: race.teamAName ?? null,
        teamBName: race.teamBName ?? null,
      });
      try {
        await require("../../social/services/raceMessagesCache").invalidateKind(
          raceId,
          "SYSTEM"
        );
      } catch {}
      return raceModel.findById(raceId);
    }

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
      ...startFields,
      potCoins: (race.potCoins || 0) + heldPot,
    });
    if (flip.count === 0) {
      return raceModel.findById(raceId);
    }

    // Snapshot each participant's current steps so only post-race steps count.
    // Shared with the tournament engine's round creation via snapshotBaselineFields.
    for (const p of acceptedParticipants) {
      const updateFields = await snapshotBaselineFields({
        participant: p,
        race,
        startedAt,
        stepsModel,
      });
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

    await enqueueRaceResolution({
      raceId,
      userId,
      reason: "RACE_START",
      priority: "IMMEDIATE",
    });

    return raceModel.findById(raceId);
  };
}

const startRace = buildStartRace();

module.exports = { buildStartRace, startRace, RaceStartError };
