# Backend economy ledger

## Race payout rewarded-ad double

`race_payout_ad_double` is a system-funded source credited only through
`awardCoins`, with the immutable offer UUID as `refId`. Its amount is bounded
by the authoritative eligible race-ledger sum, a hard 100-coin batch ceiling,
and the durable hashed-identity 100-coin rolling-24-hour allowance. Offer
preparation and claim settlement enforce the ceiling independently; claim also
repairs a legacy persisted oversized offer before issuing coins.

Only exact positive `race_prize_pool_payout` (`<raceId>:<placement>`) and
`race_finish_reward` (`<raceId>:rank:<placement>`) source rows qualify. Buy-in
payouts/refunds and every unrelated reason are excluded. Rollout stops disable
preparation without invalidating pending claims; the claim switch is reserved
as an exceptional exploit brake.

**Historical production snapshot — verified 2026-08-16, superseded by the
2026-08-18 100-coin correction:**

| Item | Value | Source of truth |
| --- | ---: | --- |
| Per-offer / rolling-24h-per-identity cap | **100 coins** | hard ceiling in `racePayoutDoublePolicy.js`; `RACE_PAYOUT_DOUBLE_MAX_BONUS_COINS` may tune downward only |
| `racePayoutDoubleRolloutPercent` | 0 at snapshot time (later raised to 100%) | `app_settings` row |
| Lifetime claims | 10 claims / 1,554 bonus coins / 10 distinct identities, all 2026-08-15 | `race_payout_double_offers` where `status='CLAIMED'` |
| Historical largest single claim | 500 coins (before the 100-coin correction) | same |
| Identity key | `hashAppleSub(appleId || googleSub)` | `services/racePayoutDoublePolicy.js` |

Eligible base is the sum of exact positive race prize rows. Prod prize-payout
distribution (7d): 744 rows, median 1 coin, mean 51, max 2,163 —
`coin_transactions.reason='race_prize_pool_payout'`. No `race_finish_reward`
rows minted in the trailing 7 days.

Economy context (7d, prod `coin_transactions`): total mint ≈ 19,632 coins/day,
total sink ≈ 5,921 coins/day; per-user daily earn p10 = 1, median = 80,
p90 = 203 (n = 1,243 user-days). DAU ≈ 447, 613 total users.

## QUICK_CREATE live-membership cap

**Approved target: 5 live memberships per user (2026-08-13).** A membership is
an accepted participant row in a `PENDING` or `ACTIVE` race whose
`creation_source` is `QUICK_CREATE`, across both creator and joiner roles. The
shared `quick-membership:<userId>` advisory lock makes the count and join
atomic across the public-ID and share-token join paths. Normal quick creation
is stricter: a user already participating in any live human-created race cannot
create another quick race, so multi-race exposure mainly comes from joining
races hosted by other users.

The cap bounds reuse of one walking stream. The same raw steps independently
count toward placement and the 2,000-step mystery-box thresholds in every race,
and every qualifying membership contributes to an app-funded prize pool. At
fields of at least three qualifying walkers, symmetric prize EV is 40 coins per
participant for a 2-day quick race and 80 for a 7-day quick race. Moving the cap
from 3 to 5 therefore changes maximum concurrent exposure by `5 / 3 = 1.667`,
or **+66.7%**:

| Exposure at the membership ceiling | Cap 3 | Cap 5 | Delta |
| --- | ---: | ---: | ---: |
| Concurrent prize/box streams | 3x | 5x | +66.7% |
| 2-day symmetric prize EV | 120 coins | 200 coins | +80 |
| 7-day symmetric prize EV | 240 coins | 400 coins | +160 |
| Nominal box thresholds | `3 × rawSteps / 2,000` | `5 × rawSteps / 2,000` | +66.7% |

This is a bounded tradeoff, not a removal of the abuse guard: colluding users
can still reuse the same walking across five free, app-funded races, but cannot
scale that loop with every available quick race. Monitor quick-race payouts,
boxes per user-day, discard coins, and concentration among users at the cap.

**Source-of-truth check (2026-08-13):**
`src/modules/races/services/nextRacePolicy.js` sets the shared
`MAX_LIVE_QUICK_MEMBERSHIPS` constant to 5. Both the public-ID and share-token
join paths enforce that constant, with integration coverage for capable and
frozen clients. Historical production baseline before the 3-to-5 change: a
read-only aggregate found five active `QUICK_CREATE` races and two users at the
then-current cap of 3. All five races had `exit_actions_enabled = false`, so the
membership-limit error could not promise that those users could leave.
