const { Race } = require("../models/race");
const { computeRacePayouts } = require("../utils/racePayoutPresets");

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

    const summary = {
      id: race.id,
      name: race.name,
      targetSteps: race.targetSteps,
      status: race.status,
      maxDurationDays: race.maxDurationDays,
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
      startedAt: race.startedAt,
      endsAt: race.endsAt,
      completedAt: race.completedAt,
      creator: race.creator,
      winner: race.winner,
      participantCount: acceptedCount,
      myStatus: myParticipant?.status || null,
      myBuyInStatus: myParticipant?.buyInStatus || "NONE",
      myPayoutCoins: myParticipant?.payoutCoins || 0,
      isCreator: race.creatorId === userId,
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
