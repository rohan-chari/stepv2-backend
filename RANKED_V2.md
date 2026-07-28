# Ranked v2 — weekly cohorts

Persistent-tier, weekly-cohort ladder. Replaces the RP season system as the
*live* ranked mode; the legacy season machinery keeps running (rewards zeroed)
purely to serve shipped app binaries on `GET /ranked`.

## Model

Two layers:

- **Tier** (`User.rankedTierV2`): sticky identity across weeks —
  BRONZE → SILVER → GOLD → PLATINUM → DIAMOND → LEGEND. Everyone starts
  Bronze (full restart; no carry-over from the legacy season tiers).
- **Cohort**: each week, ~30 same-tier players, roughly step-matched. Score is
  the raw weekly step total. Placement at week end moves your tier.

Weekly loop (all on the UTC-midnight date axis, matching `Step.date`):

1. **Monday rollover** — `jobs/computeRankedWeeks.js` opens the week and
   enrolls everyone with ≥ 1 active day (≥ 5,000 steps) last week, sorted by
   last week's steps and chunked into balanced cohorts (`COHORT_TARGET_SIZE`).
2. **Live standings** — every 5 min: weekly totals, provisional ranks, and
   placement of mid-week joiners (first sync of the week → straight into the
   emptiest same-tier cohort with headroom, or a fresh one).
3. **Settlement** — at `endsOn + SETTLE_GRACE_HOURS` (18h, so Sunday-evening
   steps from behind-UTC timezones still land): top zone promotes, bottom zone
   demotes, middle holds. Zones are proportional (`7/30` of cohort size);
   Bronze never demotes, Legend never promotes.

## Rewards (constants/rankedCohorts.js)

- Placement coins (base 200/150/120 podium, 80 promotion zone, 40/20 hold,
  0 demotion zone) × tier multiplier (1.0 → 3.0), rounded to 5.
- One-time promotion bonus on first-ever entry into a tier (idempotent via
  `awardCoins` refId `tier:{tier}:user:{userId}`).
- Weekly payout refId `week:{weekId}:user:{userId}` — settlement re-runs never
  double-pay.
- **Anti-farming**: payout and promotion require ≥ 1 active day in the week.
  Idle accounts can hold or demote, never climb or earn.
- **Legend cosmetic** (`ranked_legend_crown`, `earnOnly` shop item): granted to
  anyone settling in or promoting into LEGEND. Never listed, never buyable.

## Back-compat invariants

- `GET /ranked` (legacy seasons) must keep working for app ≤ 1.2.0. Its tier
  rewards are zeroed (`rankedTiers.js`) so coins mint only via v2; the old UI
  hides 0-coin reward lines. Never return 404 from it — old builds treat that
  as a permanent "coming soon".
- `User.currentTier`/`currentDivision` stay owned by legacy settlement (the
  badge old clients see must match the ladder they see). v2 writes only
  `rankedTierV2`, surfaced additively as `rankedTierV2` on `/steps/stats`.
- App 1.3.0 calls `GET /ranked/v2` and falls back to `/ranked` on failure, so
  it works against pre-v2 backends. All thresholds/zones/reward tables are
  server-driven — do not hardcode them in the app again.
- Clients ≥ 1.3.0 send `X-App-Version` on every request.

## Deploy checklist

1. `prisma migrate deploy` (additive: `ranked_weeks`, `ranked_cohorts`,
   `ranked_cohort_members`, `users.ranked_tier_v2*`, `shop_items.earn_only`).
2. Seed `ranked_legend_crown` (historical: this was done via the since-removed
   `cosmetics-apply.js`; new items are now created via `POST /admin/shop/items`).
3. Restart the API — `scheduleComputeRankedWeeks` opens the first week within
   one tick and enrolls from the previous 7 days of steps.
4. The same deploy zeroes legacy season rewards (no separate step).
