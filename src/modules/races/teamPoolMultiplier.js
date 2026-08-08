// Team race payout buff (batch 2026-08-08, item 5).
//
// A TEAM race's funded prize pool is the shared formula multiplied by a factor
// that depends only on how long the race runs. Winners split the result, so a
// 14-day 5v5 winner takes 600 instead of 320.
//
// STAMP AT CREATION, SETTLE FROM THE STAMP — the project idiom for every
// payout-sensitive knob (payoutCurve, fundedPrize). `resolveTeamPoolMultBps` is
// called EXACTLY ONCE per race, at creation, and the basis points are written
// to races.team_pool_mult_bps. Every later reader (projection AND settlement)
// consults the column. Consequences, both intended:
//   - an env edit reprices only races created after it; an in-flight race can
//     never change what it advertised mid-race;
//   - a legacy row (NULL, created before this column existed) means 1.0 and
//     settles at exactly its pre-buff numbers.
//
// Individual races, seeded challenges and tournament matchup races stamp NULL:
// the buff is a team-mode incentive only, and tournaments must be provably
// unaffected (they call computePrizePool with their own tighter ceiling).

// There is no float env parser in this repo (positiveIntEnv in economy/adRewards
// is integers-only), and a NaN here would multiply a payout to zero — so parse
// defensively: anything that isn't a finite positive number falls back.
function positiveFloatEnv(raw, fallback) {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// Bands mirror durationPoints' shape but are deliberately coarser: the buff is
// about making a LONG commitment pay, so short races are untouched (1.0).
const BANDS = [
  { maxDays: 3, env: "TEAM_POOL_MULT_SHORT", fallback: 1.0 },
  { maxDays: 7, env: "TEAM_POOL_MULT_MID", fallback: 1.5 },
  { maxDays: Infinity, env: "TEAM_POOL_MULT_LONG", fallback: 1.875 },
];

// Basis points (1.875 -> 18750) for a team race of `durationDays`, read from
// env at CREATION time only. Returns null for a non-team race so the column
// stays NULL and every downstream reader takes the 1.0 path.
function resolveTeamPoolMultBps({ isTeamRace, durationDays }) {
  if (isTeamRace !== true) return null;
  const days = Math.max(0, Math.floor(Number(durationDays) || 0));
  const band = BANDS.find((b) => days <= b.maxDays) || BANDS[BANDS.length - 1];
  const multiplier = positiveFloatEnv(process.env[band.env], band.fallback);
  return Math.round(multiplier * 10000);
}

// The multiplier a race row carries, for the pool formula. Gated on isTeamRace
// as well as the column so a stamp that somehow landed on an individual race
// (a bad backfill, a copied row) can never quietly inflate its pool.
function raceTeamPoolMultBps(race) {
  if (race?.isTeamRace !== true) return null;
  return race?.teamPoolMultBps ?? null;
}

module.exports = {
  positiveFloatEnv,
  resolveTeamPoolMultBps,
  raceTeamPoolMultBps,
};
