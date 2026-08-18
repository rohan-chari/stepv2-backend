// Tournament coin ledger (§7). All writes go through the idempotent awardCoins
// contract via shared/economy/buyIns (@@unique(userId, reason, refId)). Every
// buy-in refId is VERSIONED from day one (:v0 for the first hold): the version
// lives on TournamentParticipant.buyInVersion and is incremented at refund
// time, so a re-hold after a leave->rejoin cycle uses :v1, :v2, … and can never
// silently no-op against a stale ledger row. A free tournament (amount 0)
// writes nothing.
const {
  buildAtomicHoldFn,
  creditBuyIn,
  ensureUserCanAfford,
  holdBuyIn,
} = require("../../../shared/economy/buyIns");

function holdRefId(tournamentId, userId, version) {
  return `${tournamentId}:${userId}:v${version}`;
}

async function reserveTournamentBuyIn({ awardCoinsFn, userId, tournamentId, amount, version = 0 }) {
  return holdBuyIn({
    awardCoinsFn,
    userId,
    amount,
    reason: "tournament_buy_in_hold",
    refId: holdRefId(tournamentId, userId, version),
  });
}

async function refundTournamentBuyIn({ awardCoinsFn, userId, tournamentId, amount, version = 0 }) {
  return creditBuyIn({
    awardCoinsFn,
    userId,
    amount,
    reason: "tournament_buy_in_refund",
    refId: holdRefId(tournamentId, userId, version),
  });
}

// Pot payout for a user-created (paid) tournament champion.
async function payoutTournamentPot({ awardCoinsFn, userId, tournamentId, amount, payoutMetadata }) {
  return creditBuyIn({
    awardCoinsFn,
    userId,
    amount,
    reason: "tournament_payout",
    refId: `${tournamentId}:champion`,
    payoutMetadata,
  });
}

// Minted champion prize for a featured (seeded) tournament — a distinct reason
// from the pot payout so the two never collide, mirroring seeded races'
// race_finish_reward vs buy-in payout separation.
async function mintChampionPrize({ awardCoinsFn, userId, tournamentId, amount, payoutMetadata }) {
  return creditBuyIn({
    awardCoinsFn,
    userId,
    amount,
    reason: "tournament_champion_reward",
    refId: `${tournamentId}:champion`,
    payoutMetadata,
  });
}

// App-funded bracket pool for a free-entry tournament's champion. Distinct
// reason from both the pot payout and the featured seed prize, so the three
// branches can never collide on the shared "<tournamentId>:champion" refId.
async function mintTournamentPrizePool({ awardCoinsFn, userId, tournamentId, amount, payoutMetadata }) {
  return creditBuyIn({
    awardCoinsFn,
    userId,
    amount,
    reason: "tournament_prize_pool_payout",
    refId: `${tournamentId}:champion`,
    payoutMetadata,
  });
}

module.exports = {
  buildAtomicHoldFn,
  mintTournamentPrizePool,
  ensureUserCanAfford,
  reserveTournamentBuyIn,
  refundTournamentBuyIn,
  payoutTournamentPot,
  mintChampionPrize,
};
