const { Race } = require("../models/race");
const { RaceParticipant } = require("../models/raceParticipant");
const { RaceActiveEffect } = require("../../powerups/models/raceActiveEffect");
const { RacePowerupEvent } = require("../../powerups/models/racePowerupEvent");
const { Steps } = require("../../steps/models/steps");
const { StepSample } = require("../../steps/models/stepSample");
const { GlobalStepEvent } = require("../../steps/models/globalStepEvent");
const { eventsForUser } = require("../../steps/services/globalStepEventEntitlement");
const {
  invalidateHomeActiveGlobalEvent,
} = require("../../steps/services/globalStepEventEntitlement");
const { prisma: defaultPrisma } = require("../../../db");
const { eventBus } = require("../../../shared/events/eventBus");
const { completeRace: defaultCompleteRace } = require("./completeRace");
const {
  calculateBaseAdjusted,
  calculateCurrentTotal,
} = require("../services/raceStateResolution");
const { raceTimeZone } = require("../raceTimeZone");
const { applyLeechTransfers } = require("../../powerups/leechTransfers");
const {
  collectRaceHitchhikeCopies,
  applyHitchhikeCopies,
} = require("../../powerups/hitchhikeCopies");
const { computeRaceState } = require("../services/computeRaceState");
const { appSettings } = require("../../../shared/config/appSettings");
const {
  isStrictFlagEnabled,
} = require("../../../shared/config/isStrictFlagEnabled");

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

const {
  enqueueRaceResolution: defaultEnqueueRaceResolution,
} = require("../services/enqueueRaceResolution");
// C3 (spec §5 Phase D step 9): this write seam is a snapshot DEL hook — the
// shared standings snapshot must not outlive the change we just committed. The
// resolution worker is deliberately NOT in this list: it SETs post-commit.
const {
  invalidateRaceProgress,
} = require("../services/raceProgressSnapshot");

function buildForfeitRace(dependencies = {}) {
  // C0 (spec §5a item 4): after this command's own small writes, mark the race
  // dirty so the race-keyed worker re-converges its standings. Best-effort and
  // stubbed out for injected fakes so unit tests stay DB-free.
  const enqueueRaceResolution = Object.prototype.hasOwnProperty.call(
    dependencies,
    "enqueueRaceResolution"
  )
    ? dependencies.enqueueRaceResolution
    : Object.keys(dependencies).length > 0
      ? async () => null
      : defaultEnqueueRaceResolution;
  const raceModel = dependencies.Race || Race;
  const participantModel = dependencies.RaceParticipant || RaceParticipant;
  const powerupEventModel = dependencies.RacePowerupEvent || RacePowerupEvent;
  const db = dependencies.prisma || defaultPrisma;
  const completeRaceFn = dependencies.completeRace || defaultCompleteRace;
  const events = dependencies.eventBus || eventBus;
  const now = dependencies.now || (() => new Date());
  const activeImpactEnabled = dependencies.activeImpactEnabled || (async () => {
    // Keep dependency-injected unit commands DB-free. The production singleton
    // has no injected dependencies and reads the default-off runtime flag.
    if (Object.keys(dependencies).length > 0 && !dependencies.appSettings) return false;
    return isStrictFlagEnabled(
      dependencies.appSettings || appSettings,
      "apiActiveImpactNoticesV1Enabled",
    );
  });
  const computeState = dependencies.computeRaceState || computeRaceState;

  function buildFrozenImpactWork({ capture, participant, resolvedAt }) {
    const bySource = new Map();
    const add = ({ sourceId, powerupType, deltaSteps }) => {
      if (!sourceId || !powerupType) return;
      const key = `ACTIVE_EFFECT:${sourceId}`;
      const existing = bySource.get(key);
      bySource.set(key, {
        sourceKind: "ACTIVE_EFFECT",
        sourceId,
        powerupType,
        deltaSteps: (existing?.deltaSteps || 0) + Math.round(Number(deltaSteps) || 0),
      });
    };
    for (const impact of capture?.freezeTimedImpacts || []) {
      if (impact.userId === participant.userId) {
        add({ sourceId: impact.effectId, powerupType: impact.powerupType, deltaSteps: impact.deltaSteps });
      }
    }
    for (const resolution of capture?.leechResolutions || []) {
      if (resolution.victimParticipantId === participant.id) {
        add({ sourceId: resolution.effectId, powerupType: "LEECH", deltaSteps: -resolution.actualTransfer });
      }
      if (resolution.sourceUserId === participant.userId) {
        add({ sourceId: resolution.effectId, powerupType: "LEECH", deltaSteps: resolution.actualTransfer });
      }
    }
    for (const copy of capture?.hitchhikeCopies || []) {
      if (copy.sourceUserId === participant.userId) {
        add({ sourceId: copy.effectId, powerupType: "HITCHHIKE", deltaSteps: copy.copiedSteps });
      }
    }
    return [...bySource.values()].map(({ deltaSteps, ...work }) => ({
      ...work,
      raceId: participant.raceId,
      recipientUserId: participant.userId,
      status: "PENDING",
      resolvedAt,
      capturedDeltaSteps: deltaSteps,
      calculationVersion: 1,
    }));
  }

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
      let eventsByUserId = null;
      if (typeof globalStepEventModel.findEligibleByRace === "function") {
        eventsByUserId = await globalStepEventModel.findEligibleByRace({
          raceId: race.id,
          userIds: [participant.userId],
          rangeStart: race.startedAt,
          rangeEnd: at,
        });
        globalEvents = eventsForUser(eventsByUserId, participant.userId);
      } else {
        try {
          globalEvents =
            (await globalStepEventModel.findActiveInRange(race.startedAt, at)) || [];
        } catch {
          globalEvents = [];
        }
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
            globalEvents,
            eventsByUserId,
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

  return async function forfeitRace({
    userId,
    raceId,
    // Internal capability path used only by POST /races/:id/leave. The public
    // /forfeit endpoint never supplies these options, preserving old clients.
    allowIndividual = false,
    requireExitPolicy = false,
  }) {
    const race = await raceModel.findById(raceId);
    if (!race) {
      throw new RaceForfeitError("Race not found", 404, "RACE_NOT_FOUND");
    }
    if (race.tournamentId) {
      throw new RaceForfeitError(
        "This race is managed by its tournament",
        400,
        "TOURNAMENT_RACE_LOCKED"
      );
    }
    if (!race.isTeamRace && !allowIndividual) {
      throw new RaceForfeitError(
        "Only team races support forfeiting",
        400
      );
    }
    if (requireExitPolicy && race.exitActionsEnabled !== true) {
      throw new RaceForfeitError(
        "This race does not support leaving",
        400,
        "RACE_NOT_LEAVABLE"
      );
    }
    if (requireExitPolicy && race.creatorId === userId) {
      throw new RaceForfeitError(
        "The race creator can't leave. Cancel the race instead",
        400,
        "RACE_CREATOR_CANNOT_LEAVE"
      );
    }
    if (race.status !== "ACTIVE") {
      throw new RaceForfeitError(
        "You can only forfeit a race that is in progress",
        400,
        "RACE_NOT_LEAVABLE"
      );
    }

    // Once the deadline has passed, expiry owns settlement. Do not mutate a
    // row from a stale ACTIVE snapshot while that worker ranks and pays it.
    if (
      requireExitPolicy &&
      race.endsAt &&
      new Date(race.endsAt) <= now()
    ) {
      throw new RaceForfeitError(
        "You can only forfeit a race that is in progress",
        400,
        "RACE_NOT_LEAVABLE"
      );
    }

    const participant = await participantModel.findByRaceAndUser(
      raceId,
      userId
    );
    if (!participant || participant.status !== "ACCEPTED") {
      throw new RaceForfeitError("You are not in this race", 403, "NOT_A_PARTICIPANT");
    }
    if (participant.forfeitedAt) {
      throw new RaceForfeitError(
        "You have already forfeited this race",
        400
      );
    }
    if (
      race.isTeamRace &&
      participant.team !== "TEAM_A" &&
      participant.team !== "TEAM_B"
    ) {
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
    let frozenImpactWork = [];
    if (await activeImpactEnabled()) {
      const computed = await computeState({
        raceId,
        timeZone: raceTimeZone(race, "UTC"),
        userIds: [userId],
        dependencies: { activeImpactEnabled: true, now: () => forfeitedAt },
      });
      frozenImpactWork = buildFrozenImpactWork({
        capture: computed?.result?.activeImpactCapture,
        participant,
        resolvedAt: forfeitedAt,
      });
    }

    // Atomic forfeit + collapse evaluation (TR-604).
    const collapse = await db.$transaction(async (tx) => {
      // Lock and re-check the lifecycle row inside the same mutation
      // transaction. A completion that wins after our optimistic read makes
      // this a normal RACE_NOT_LEAVABLE conflict, never a late forfeit write.
      await tx.$queryRawUnsafe(
        `SELECT id FROM races WHERE id = $1 FOR UPDATE`,
        raceId
      );
      const lockedRace = tx.race?.findUnique
        ? await tx.race.findUnique({
            where: { id: raceId },
            select: { status: true, endsAt: true },
          })
        : { status: race.status, endsAt: race.endsAt };
      if (
        !lockedRace ||
        lockedRace.status !== "ACTIVE" ||
        (requireExitPolicy &&
          lockedRace.endsAt &&
          new Date(lockedRace.endsAt) <= forfeitedAt)
      ) {
        return { noLongerActive: true };
      }
      // Serialize concurrent forfeits on this race: lock all its participant
      // rows so the alive-count below always sees committed truth.
      //
      // ORDER BY user_id is REQUIRED, not cosmetic (spec §5a item 7): this is a
      // multi-row race_participants writer, and the ONE global lock order every
      // such writer obeys — the race-keyed resolution worker, this scan, and any
      // multi-target powerup — is ascending userId. A shared lock order means no
      // deadlock cycle is constructible. The LockRows node sits above the Sort,
      // so rows really are locked in sorted order.
      await tx.$queryRawUnsafe(
        `SELECT id FROM race_participants WHERE race_id = $1 ORDER BY user_id ASC FOR UPDATE`,
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

      // The recipient is about to leave canonical live scoring. Freeze every
      // independently attributable source in the same transaction as the
      // participant lifecycle write; retryable presentation can materialize
      // later without ever recomputing against a frozen field.
      for (const work of frozenImpactWork) {
        await tx.activeRaceImpactWork.upsert({
          where: {
            raceId_recipientUserId_sourceKind_sourceId_calculationVersion: {
              raceId: work.raceId,
              recipientUserId: work.recipientUserId,
              sourceKind: work.sourceKind,
              sourceId: work.sourceId,
              calculationVersion: work.calculationVersion,
            },
          },
          update: {},
          create: work,
        });
      }

      const accepted = await tx.raceParticipant.findMany({
        where: { raceId, status: "ACCEPTED" },
      });
      if (!race.isTeamRace) return { collapsed: false };

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
    if (collapse.noLongerActive) {
      throw new RaceForfeitError(
        "You can only forfeit a race that is in progress",
        400,
        "RACE_NOT_LEAVABLE"
      );
    }

    // Feed row so the race feed narrates the forfeit.
    try {
      await powerupEventModel.create({
        raceId,
        actorUserId: userId,
        eventType: "PARTICIPANT_FORFEITED",
        description: `${participant.user?.displayName || "A runner"} forfeited. Their steps stay with the team.`,
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

    await invalidateRaceProgress(raceId);
    await invalidateHomeActiveGlobalEvent([userId]);

    // Team collapse completes the race inline; an ACTIVE-only worker would
    // immediately no-op afterward. Non-collapse forfeits still need convergence.
    if (!collapse.collapsed) {
      await enqueueRaceResolution({
        raceId,
        userId,
        reason: "FORFEIT_TEAM",
        priority: "IMMEDIATE",
      });
    }

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
