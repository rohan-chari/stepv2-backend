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
