const { Race } = require("../models/race");
const { RaceParticipant } = require("../models/raceParticipant");
const { RaceActiveEffect } = require("../models/raceActiveEffect");
const { RacePowerupEvent } = require("../models/racePowerupEvent");
const { Steps } = require("../models/steps");
const { StepSample } = require("../models/stepSample");
const { GlobalStepEvent } = require("../models/globalStepEvent");
const { prisma: defaultPrisma } = require("../db");
const { eventBus } = require("../events/eventBus");
const { completeRace: defaultCompleteRace } = require("./completeRace");
const {
  calculateBaseAdjusted,
  calculateCurrentTotal,
} = require("../services/raceStateResolution");
const { raceTimeZone } = require("../utils/raceTimeZone");
const { applyLeechTransfers } = require("../utils/leechTransfers");
const {
  collectRaceHitchhikeCopies,
  applyHitchhikeCopies,
} = require("../utils/hitchhikeCopies");

// Mid-race forfeit for TEAM races (TR-601..604).
//
// - The member's effective total is snapshotted AS-IS at the forfeit moment —
//   the same live math the leaderboard uses, INCLUDING any active debuff
//   (mid-Leg-Cramp bites permanently; no hypothetical expiry recompute). The
//   frozen value is written into totalSteps and forfeitedAt marks the freeze;
//   every resolution path (live + settlement) skips recomputing them.
// - Forfeit is permanent: no rejoin, buy-in stays committed, no payout cut.
// - TEAM COLLAPSE (TR-603): the moment every member of one team has forfeited,
//   the race completes instantly in the other team's favor via the SAME
//   completeRace path as a deadline settlement.
// - SEQUENCING (TR-604): the forfeit write and the collapse evaluation happen
//   in one transaction that first takes row locks on the race's participants
//   (SELECT ... FOR UPDATE), so two "last members" of opposite teams
//   forfeiting concurrently serialize — exactly one collapse wins, and
//   completeRace's conditional ACTIVE->COMPLETED flip is the final backstop.
class RaceForfeitError extends Error {
  constructor(message, statusCode, code) {
    super(message);
    this.name = "RaceForfeitError";
    if (statusCode) this.statusCode = statusCode;
    if (code) this.code = code;
  }
}

function buildForfeitRace(dependencies = {}) {
  const raceModel = dependencies.Race || Race;
  const participantModel = dependencies.RaceParticipant || RaceParticipant;
  const powerupEventModel = dependencies.RacePowerupEvent || RacePowerupEvent;
  const db = dependencies.prisma || defaultPrisma;
  const completeRaceFn = dependencies.completeRace || defaultCompleteRace;
  const events = dependencies.eventBus || eventBus;
  const now = dependencies.now || (() => new Date());

  // The member's live effective total, computed with the shared resolution
  // math (post-powerup, race-canonical tz, global events). Injectable for
  // tests; the default mirrors resolveRaceState's per-participant compute.
  const computeParticipantEffectiveTotal =
    dependencies.computeParticipantEffectiveTotal ||
    (async ({ race, participant, at }) => {
      const stepsModel = dependencies.Steps || Steps;
      const stepSampleModel = dependencies.StepSample || StepSample;
      const raceActiveEffectModel =
        dependencies.RaceActiveEffect || RaceActiveEffect;
      const globalStepEventModel =
        dependencies.GlobalStepEvent || GlobalStepEvent;

      let globalEvents = [];
      try {
        globalEvents =
          (await globalStepEventModel.findActiveInRange(race.startedAt, at)) ||
          [];
      } catch {
        globalEvents = [];
      }

      const { baseAdjusted, hasSampleData } = await calculateBaseAdjusted({
        participant,
        raceStartedAt: race.startedAt,
        timeZone: raceTimeZone(race, "UTC"),
        stepsModel,
        stepSampleModel,
        now: at,
      });

      const { total, leechTransfers } = await calculateCurrentTotal({
        raceId: race.id,
        racePowerupsEnabled: race.powerupsEnabled,
        participant,
        baseAdjusted,
        hasSampleData,
        raceActiveEffectModel,
        stepSampleModel,
        globalEvents,
        now: at,
      });

      // §7.3: fold in the forfeiter's OWN hitchhike copies BEFORE the leech
      // resolution, exactly as every other assembly site does. This total is
      // FROZEN permanently and feeds standings and payouts, so dropping the
      // copy here would silently delete steps the caster had already earned and
      // seen. Unlike leech attacker credit, the copy is exact on a
      // single-participant path — it depends only on the target's step history,
      // never on victim availability.
      //
      // The forfeiter is the one leaving, so both roles matter and both are
      // handled by the shared collector: as a CASTER their accrued copy is
      // preserved (their own forfeit never clamps their own links), and as a
      // TARGET the clamp lives on the OTHER participant's total, computed
      // elsewhere. `now: at` also means the shared in-progress-hour exclusion
      // applies here as it does everywhere — the same monotonicity tradeoff
      // already accepted for Leech, kept identical so no path can disagree.
      const hitchhikeCopies = race.powerupsEnabled
        ? await collectRaceHitchhikeCopies({
            raceId: race.id,
            raceEndsAt: race.endsAt,
            participants: race.participants,
            raceActiveEffectModel,
            stepSampleModel,
            now: at,
          })
        : [];

      // §5: freeze the forfeiter's total INCLUDING any leech drain against them
      // (the old debuff-folded behavior). Single-participant -> drain-only (no
      // attacker credit computed here), matching the sync-v2 reconcile path.
      const leechFinals = applyLeechTransfers(
        applyHitchhikeCopies(
          [
            {
              participantId: participant.id,
              userId: participant.userId,
              preLeechTotal: total,
              leechTransfers,
            },
          ],
          hitchhikeCopies
        )
      );
      return leechFinals.get(participant.id) ?? total;
    });

  return async function forfeitRace({ userId, raceId }) {
    const race = await raceModel.findById(raceId);
    if (!race) {
      throw new RaceForfeitError("Race not found", 404);
    }
    if (race.tournamentId) {
      throw new RaceForfeitError(
        "This race is managed by its tournament",
        400,
        "TOURNAMENT_RACE_LOCKED"
      );
    }
    if (!race.isTeamRace) {
      throw new RaceForfeitError(
        "Only team races support forfeiting",
        400
      );
    }
    if (race.status !== "ACTIVE") {
      throw new RaceForfeitError(
        "You can only forfeit a race that is in progress",
        400
      );
    }

    const participant = await participantModel.findByRaceAndUser(
      raceId,
      userId
    );
    if (!participant || participant.status !== "ACCEPTED") {
      throw new RaceForfeitError("You are not in this race", 403);
    }
    if (participant.forfeitedAt) {
      throw new RaceForfeitError(
        "You have already forfeited this race",
        400
      );
    }
    if (participant.team !== "TEAM_A" && participant.team !== "TEAM_B") {
      throw new RaceForfeitError("You are not on a team in this race", 400);
    }

    const forfeitedAt = now();
    // Snapshot the effective total BEFORE the transaction (heavy step math has
    // no business inside a row-lock window; sub-second drift is irrelevant).
    const frozenTotal = Math.max(
      0,
      await computeParticipantEffectiveTotal({
        race,
        participant,
        at: forfeitedAt,
      })
    );

    // Atomic forfeit + collapse evaluation (TR-604).
    const collapse = await db.$transaction(async (tx) => {
      // Serialize concurrent forfeits on this race: lock all its participant
      // rows so the alive-count below always sees committed truth.
      await tx.$queryRawUnsafe(
        `SELECT id FROM race_participants WHERE race_id = $1 FOR UPDATE`,
        raceId
      );

      // Conditional write — a concurrent duplicate forfeits nothing.
      const write = await tx.raceParticipant.updateMany({
        where: { id: participant.id, forfeitedAt: null },
        data: { forfeitedAt, totalSteps: frozenTotal },
      });
      if (write.count === 0) {
        return { alreadyForfeited: true };
      }

      const accepted = await tx.raceParticipant.findMany({
        where: { raceId, status: "ACCEPTED" },
      });
      const aliveByTeam = { TEAM_A: 0, TEAM_B: 0 };
      for (const row of accepted) {
        if (row.forfeitedAt) continue;
        // The forfeiter's own row was updated above; recheck defensively for
        // injected fakes that don't mutate in place.
        if (row.id === participant.id) continue;
        if (row.team === "TEAM_A") aliveByTeam.TEAM_A += 1;
        else if (row.team === "TEAM_B") aliveByTeam.TEAM_B += 1;
      }

      const myTeam = participant.team;
      const otherTeam = myTeam === "TEAM_A" ? "TEAM_B" : "TEAM_A";
      if (aliveByTeam[myTeam] === 0) {
        return {
          collapsed: true,
          winnerTeam: otherTeam,
          participantUserIds: accepted.map((row) => row.userId),
        };
      }
      return { collapsed: false };
    });

    if (collapse.alreadyForfeited) {
      throw new RaceForfeitError(
        "You have already forfeited this race",
        400
      );
    }

    // Feed row so the race feed narrates the forfeit.
    try {
      await powerupEventModel.create({
        raceId,
        actorUserId: userId,
        eventType: "PARTICIPANT_FORFEITED",
        description: `${participant.user?.displayName || "A runner"} forfeited — their steps stay with the team.`,
        metadata: { frozenTotal, team: participant.team },
      });
    } catch {
      // Feed row is cosmetic; never fail the forfeit for it.
    }

    let completedRace = null;
    if (collapse.collapsed) {
      // TR-603: instant win for the surviving team — same completion path as a
      // deadline settlement (placements, payouts, pushes). completeRace's
      // conditional ACTIVE->COMPLETED flip makes concurrent collapses safe.
      completedRace = await completeRaceFn({
        raceId,
        winnerUserId: null,
        winnerTeam: collapse.winnerTeam,
        participantUserIds: collapse.participantUserIds,
      });
    }

    events.emit("RACE_PARTICIPANT_FORFEITED", {
      raceId,
      userId,
      team: participant.team,
      collapsed: collapse.collapsed === true,
      winnerTeam: collapse.collapsed ? collapse.winnerTeam : null,
    });

    const updated = await participantModel.findByRaceAndUser(raceId, userId);
    return {
      participant: updated || {
        ...participant,
        forfeitedAt,
        totalSteps: frozenTotal,
      },
      collapsed: collapse.collapsed === true,
      race: completedRace,
    };
  };
}

const forfeitRace = buildForfeitRace();

module.exports = { buildForfeitRace, forfeitRace, RaceForfeitError };
