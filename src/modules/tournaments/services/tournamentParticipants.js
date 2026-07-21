const { refundTournamentBuyIn } = require("./tournamentBuyIns");
const { refundHeldBuyIn } = require("../../../shared/competition/lifecycle");

// Soft-remove a participant (leave/kick/cancel): refund any HELD buy-in at the
// current version, then KEEP the row as DECLINED with the version incremented,
// so the counter survives leave->rejoin and a re-hold can never silently no-op
// against a stale ledger row (§7). Never deletes the row. Note the row update
// is UNCONDITIONAL (unlike cancel's onRefunded hook) — soft-remove always
// declines + bumps, refund or not.
async function softRemoveAndRefund({ tx, tournamentId, participant, awardCoinsFn }) {
  const version = participant.buyInVersion || 0;
  const wasHeld = await refundHeldBuyIn({
    participant,
    awardCoinsFn,
    refundFn: ({ awardCoinsFn: fn, userId, amount }) =>
      refundTournamentBuyIn({
        awardCoinsFn: fn,
        userId,
        tournamentId,
        amount,
        version,
      }),
  });
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
