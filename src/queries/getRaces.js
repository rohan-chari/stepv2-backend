const { Race } = require("../models/race");
const { RacePowerup } = require("../models/racePowerup");
const { computeRacePayouts } = require("../utils/racePayoutPresets");
const {
  getFinishRewardPool,
  FINISH_REWARD_TOP_FRACTION,
} = require("../constants/raceFinishReward");

function compareParticipantsForPlacement(left, right) {
  if (left.finishedAt && right.finishedAt) {
    const leftPlacement = left.placement ?? Number.MAX_SAFE_INTEGER;
    const rightPlacement = right.placement ?? Number.MAX_SAFE_INTEGER;
    if (leftPlacement !== rightPlacement) {
      return leftPlacement - rightPlacement;
    }

    const leftFinishedAt = new Date(left.finishedAt).getTime();
    const rightFinishedAt = new Date(right.finishedAt).getTime();
    if (leftFinishedAt !== rightFinishedAt) {
      return leftFinishedAt - rightFinishedAt;
    }
  }

  if (left.finishedAt) return -1;
  if (right.finishedAt) return 1;

  const stepDiff = (right.totalSteps || 0) - (left.totalSteps || 0);
  if (stepDiff !== 0) {
    return stepDiff;
  }

  const leftJoinedAt = left.joinedAt ? new Date(left.joinedAt).getTime() : 0;
  const rightJoinedAt = right.joinedAt ? new Date(right.joinedAt).getTime() : 0;
  if (leftJoinedAt !== rightJoinedAt) {
    return leftJoinedAt - rightJoinedAt;
  }

  return String(left.userId || "").localeCompare(String(right.userId || ""));
}

function getActivePlacement(participants, userId) {
  const acceptedParticipants = participants
    .filter((participant) => participant.status === "ACCEPTED")
    .sort(compareParticipantsForPlacement);

  const index = acceptedParticipants.findIndex(
    (participant) => participant.userId === userId
  );
  return index >= 0 ? index + 1 : null;
}

async function getRaces(userId) {
  const races = await Race.findForUser(userId);

  const active = [];
  const pending = [];
  const completed = [];

  for (const race of races) {
    const myParticipant = race.participants.find((p) => p.userId === userId);
    const acceptedCount = race.participants.filter((p) => p.status === "ACCEPTED").length;
    const heldPotCoins = race.participants.reduce((sum, participant) => {
      if (participant.buyInStatus === "HELD") {
        return sum + (participant.buyInAmount || 0);
      }
      return sum;
    }, 0);
    const projectedPotCoins = (race.potCoins || 0) + heldPotCoins;
    const payouts = computeRacePayouts({
      preset: race.payoutPreset,
      potCoins: projectedPotCoins,
    });
    const finishRewardPool = getFinishRewardPool(race.seedId);
    const myPlacement =
      race.status === "COMPLETED"
        ? myParticipant?.placement ?? null
        : race.status === "ACTIVE"
          ? getActivePlacement(race.participants, userId)
          : null;
    const queuedBoxCount =
      race.status === "ACTIVE" && race.powerupsEnabled && myParticipant
        ? await RacePowerup.countQueuedByParticipant(myParticipant.id)
        : 0;

    const summary = {
      id: race.id,
      name: race.name,
      status: race.status,
      maxDurationDays: race.maxDurationDays,
      targetSteps: race.targetSteps, // 1.1.4 compat
      buyInAmount: race.buyInAmount,
      payoutPreset: race.payoutPreset,
      potCoins: race.potCoins || 0,
      heldPotCoins,
      projectedPotCoins,
      payouts: {
        first: payouts[0],
        second: payouts[1],
        third: payouts[2],
      },
      finishReward:
        finishRewardPool > 0
          ? { pool: finishRewardPool, topFraction: FINISH_REWARD_TOP_FRACTION }
          : null,
      startedAt: race.startedAt,
      endsAt: race.endsAt,
      completedAt: race.completedAt,
      creator: race.creator,
      winner: race.winner,
      participantCount: acceptedCount,
      myStatus: myParticipant?.status || null,
      myPlacement,
      myBuyInStatus: myParticipant?.buyInStatus || "NONE",
      myPayoutCoins: myParticipant?.payoutCoins || 0,
      queuedBoxCount,
      isCreator: race.creatorId === userId,
      isPublic: race.isPublic || false,
      maxParticipants: race.maxParticipants || 10,
      createdAt: race.createdAt,
    };

    if (race.status === "ACTIVE") {
      active.push(summary);
    } else if (race.status === "PENDING") {
      pending.push(summary);
    } else if (race.status === "COMPLETED") {
      completed.push(summary);
    }
  }

  return { active, pending, completed };
}

module.exports = { getRaces };
