const { refundTournamentBuyIn } = require("./tournamentBuyIns");

// Soft-remove a participant (leave/kick/cancel): refund any HELD buy-in at the
// current version, then KEEP the row as DECLINED with the version incremented,
// so the counter survives leave->rejoin and a re-hold can never silently no-op
// against a stale ledger row (§7). Never deletes the row.
async function softRemoveAndRefund({ tx, tournamentId, participant, awardCoinsFn }) {
  const version = participant.buyInVersion || 0;
  const wasHeld =
    (participant.buyInAmount || 0) > 0 && participant.buyInStatus === "HELD";
  if (wasHeld) {
    await refundTournamentBuyIn({
      awardCoinsFn,
      userId: participant.userId,
      tournamentId,
      amount: participant.buyInAmount,
      version,
    });
  }
  await tx.tournamentParticipant.update({
    where: { id: participant.id },
    data: {
      status: "DECLINED",
      buyInStatus: wasHeld ? "REFUNDED" : participant.buyInStatus,
      buyInVersion: version + 1,
    },
  });
}

module.exports = { softRemoveAndRefund };
