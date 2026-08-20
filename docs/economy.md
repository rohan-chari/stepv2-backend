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

## App-funded race and tournament pools

**Live source-of-truth check — verified 2026-08-19.** Production has no
`app_settings` row for either `fundedPrizePoolsEnabled` or `buyInEditEnabled`,
so both resolve to their `true` defaults in
`src/shared/config/appSettings.js`. `PRIZE_COIN_UNIT` and
`PRIZE_POOL_MAX_COINS` are unset in the production environment, so the live
values are the code fallbacks **20** and **16,000** from
`src/shared/economy/prizePool.js`. The team-pool multiplier variables are also
unset, so newly created team races stamp the 1.0x fallback. User-created
tournaments retain their code cap of **1,000**.

The funded formula is
`eligible players x duration points x 20`, with duration points
`1 / 2 / 4 / 8` for `1 / <=3 / <=7 / >=8` days. Entry is free. At symmetric
skill, the expected prize per accepted player in an uncapped ordinary race is
therefore **20 / 40 / 80 / 160 coins**. A full 4-player or 8-player two-day-
round tournament has symmetric EV **80 coins/player**; a 16-player,
three-day-round bracket is capped at 1,000, or **62.5 coins/player**.

Production completions in the trailing seven days:

| Competition | Completed | Pool coins | Weighted symmetric EV / accepted player | Median per-race symmetric EV | Source of truth |
| --- | ---: | ---: | ---: | ---: | --- |
| Seeded races | 82 | 68,420 | 18.7 | 17.3 | `races.prize_pool_coins` + accepted participant aggregates |
| User individual races | 40 | 13,980 | 54.8 | 40 | same |
| User team races | 2 | 640 | 64.0 | 60 | same |
| User tournament | 1 | 320 | 80.0 | 80 | `tournaments.prize_pool_coins` |

Funded ledger reasons issued **83,360 coins in seven days**, or **11,908.6/day**
(`race_prize_pool_payout` 83,040 plus
`tournament_prize_pool_payout` 320). All positive ledger rows totaled
33,286.3/day and all negative rows sunk 10,344.9/day, so funded pools were
**35.8% of positive issuance**, exceeded all sinks by 1,563.7 coins/day on
their own, and contributed to net issuance of 22,941.4/day. Buy-ins are a
redistribution rather than a durable sink: at equal skill the expected gross
pot return equals the stake and expected net is zero before powerup spending.

Seven-day per-user-day positive earnings were p10 **1**, median **73**, p90
**200** (2,114 user-days). Against that median, the legacy race minimum of 10
costs 0.14 earning-days, the historical median hold of 40 costs 0.55 days, and
the race maximum of 200 costs 2.74 days. Tournament maxima cost 1.37 days at
100 coins (4/8 player) and 0.85 days at 62 coins (16 player).

The principal funded-pool exploit is multiplicative membership: the same walk
scores independently in every joined race while entry is free. Among 683 users
with a live funded race membership, membership count was p50 **2**, p90 **4**,
p99 **10**, maximum **17**. Concurrent symmetric prize exposure was p50 **120**,
p90 **260**, p99 **1,062.8**, maximum **1,732 coins**. The QUICK_CREATE cap of
five does not cap all other race memberships, so “join every free race” remains
a dominant strategy outside that one creation source.

Legacy compatibility is row-stamped, not controlled at settlement by the live
flag. At verification time production had 107 active and 32 pending funded
races plus one active funded user tournament. It also retained nine active and
two pending non-funded races; only one pending race still held money (two
participants, **300 coins HELD**). No live tournament held a buy-in. The
`funded_prize` discriminator, legacy payout/refund ledger paths, buy-in fields,
and legacy response aliases must remain until this monetary tail and any
recovery jobs drain; completed legacy history still needs defensive
serialization afterward. `buyInEditEnabled` is relevant only to reconciliation
on that remaining paid legacy lobby once creation is permanently funded.
