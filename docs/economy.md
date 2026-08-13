# Backend economy ledger

## Race payout rewarded-ad double

`race_payout_ad_double` is a system-funded source credited only through
`awardCoins`, with the immutable offer UUID as `refId`. Its amount is bounded
by the authoritative eligible race-ledger sum, the configured batch cap
(maximum 500), and the durable hashed-identity rolling-24-hour allowance.

Only exact positive `race_prize_pool_payout` (`<raceId>:<placement>`) and
`race_finish_reward` (`<raceId>:rank:<placement>`) source rows qualify. Buy-in
payouts/refunds and every unrelated reason are excluded. Rollout stops disable
preparation without invalidating pending claims; the claim switch is reserved
as an exceptional exploit brake.

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
