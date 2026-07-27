// App-funded prize pools — the single source of the pool formula, shared by
// races and tournaments so a projection can never disagree with a settlement.
//
//   pool = playerCount × durationPoints(durationDays) × PRIZE_COIN_UNIT
//
// Both knobs are env vars so the economy can be retuned on the droplet without
// an App Store release (the AD_COIN_REWARD_AMOUNT lesson). Read per call so a
// deploy-time .env change takes effect on restart and tests can override.
function coinUnit() {
  const parsed = Number(process.env.PRIZE_COIN_UNIT);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 20;
}

// 16,000 is the exact maximum the formula can produce for a race a USER can
// create: validateMaxParticipants caps the field at 100, and durationPoints
// saturates at 8, so 100 x 8 x 20 = 16,000 (batch 2026-07-27, item 7). The
// ceiling is therefore non-binding for user races and binds only on seeded
// daily/weekly challenges, whose maxParticipants comes from the seed row and
// bypasses that validator — that clamp is deliberate (D3), so total minting
// cannot scale without limit as signups grow. The default matches .env.example
// so a missing env var cannot silently reinstate the old 3,200 ceiling.
function poolMax() {
  const parsed = Number(process.env.PRIZE_POOL_MAX_COINS);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 16000;
}

// Duration bands, doubling at 1 / 3 / 7 / 14 days. Monotonic non-decreasing
// across the WHOLE legal range (validateDuration allows 30 and frozen clients
// still send 5), so a shorter competition can never pay more than a longer one.
function durationPoints(days) {
  const d = Math.floor(Number(days) || 0);
  if (d <= 1) return 1;
  if (d <= 3) return 2;
  if (d <= 7) return 4;
  return 8; // 8..30 days
}

// The pool for a field of `playerCount` over `durationDays`, clamped to `max`
// (races use PRIZE_POOL_MAX; tournaments pass their tighter MAX_CHAMPION_PRIZE).
// A field of fewer than 2 mints nothing — a solo race is not a competition.
function computePrizePool({ playerCount, durationDays, max = poolMax() }) {
  const players = Math.max(0, Math.floor(Number(playerCount) || 0));
  if (players < 2) return 0;
  const raw = players * durationPoints(durationDays) * coinUnit();
  return Math.min(raw, Math.max(0, Math.floor(Number(max) || 0)));
}

// The additive `prizePool` object every funded payload carries (spec §5.1/§5.2).
// `projected` is true until the competition completes; `atMax` tells the UI the
// pool has saturated so it stops implying growth. Returns null for a legacy
// buy-in competition — the client then renders today's buy-in/pot UI.
//
// `coins` may be passed explicitly (the STAMPED settled pool) so a completed
// competition's figure never drifts when its field changes afterwards.
function buildPrizePoolPayload({
  funded,
  playerCount,
  durationDays,
  projected = true,
  coins = null,
  max = poolMax(),
}) {
  if (!funded) return null;
  const ceiling = Math.max(0, Math.floor(Number(max) || 0));
  const computed = computePrizePool({ playerCount, durationDays, max: ceiling });
  const value = coins == null ? computed : Math.max(0, Math.floor(coins));
  return {
    coins: value,
    projected: projected === true,
    atMax: ceiling > 0 && value >= ceiling,
    playerCount: Math.max(0, Math.floor(Number(playerCount) || 0)),
    durationDays: Math.max(0, Math.floor(Number(durationDays) || 0)),
    durationPoints: durationPoints(durationDays),
    coinUnit: coinUnit(),
    maxCoins: ceiling,
    funded: true,
  };
}

module.exports = {
  // Exported as getters-at-require for the callers/tests that read them as
  // constants; the functions above always re-read the env.
  get PRIZE_COIN_UNIT() {
    return coinUnit();
  },
  get PRIZE_POOL_MAX() {
    return poolMax();
  },
  durationPoints,
  computePrizePool,
  buildPrizePoolPayload,
};
