# Completed Race Summary Cache Mutation Audit

This audit covers every production runtime writer that can run after a race is
completed and affect the shared fields stored under
`v1:race:completed-summary:<raceId>:<Race.updatedAt>`.

| Writer | Shared fields | Freshness proof |
|---|---|---|
| `races/commands/completeRace` normal settlement | placement, payoutCoins, winner/leader, accepted/team aggregates | Settlement now performs a final monotonic `Race.updatedAt` write after every individual, team, and tournament branch. A result read during settlement can only populate the earlier versioned key; the final touch makes it unreachable. |
| `races/commands/completeRace` payout-artifact recovery | payoutCoins and payout aggregates | Recovery uses the same final result-version touch after reconciliation. |
| `tournaments/commands/forfeitTournament` | forfeitedAt and tournament-match placement | It only targets an ACTIVE matchup and immediately calls `completeRace`; that command owns the final version touch. |
| `users/commands/deleteUserAccount` | participant user ID, roster size/order, leader identity, counts and payouts when a sentinel row collides | A completed-history reassignment/deletion now advances `Race.updatedAt` monotonically in the same database transaction. User presentation fields are not cached and continue to load live. |
| `races/commands/markRaceResultsSeen`, `setRaceFavorite`, payout-double offer/claim commands | resultsSeenAt, favorite, viewer payout-claim state | Viewer-only fields are excluded from the shared payload and are fetched on every request. No shared invalidation is needed. |
| `races/commands/setRaceChatMute`, `setRacePlacementMute`, notification delivery/baseline writers | chat/push preferences and notification markers | None of these fields is in the shared payload. |
| `races/services/legacyBuyInRemediation` and funded-exposure reconciliation | buy-in/funding bookkeeping | These fields are excluded from the shared payload. Race-level money stamps that affect the public summary use `Race.update`, which advances `updatedAt`. |
| `races/jobs/raceAdminCommandRunner` | tournament powerup activation, historical enrollment, fixed-team payout stamp | Current commands are restricted to PENDING/ACTIVE races. They cannot mutate a cached completed result. The runner also invalidates race-list membership after a committed mutation. |
| Race resolution and expiry writers | totalSteps, totalsUpdatedAt, finishedAt, placement, forfeitedAt | Resolution writers require ACTIVE status and/or unfinished participants. Expiry completes through `completeRace`, whose final touch occurs after result writes. |
| Join/leave/invite/kick/team-switch commands | membership, status, team | Their guards limit them to PENDING/ACTIVE races. They cannot mutate completed summaries. |
| Powerup/effect commands | bonus/total steps and active effects | Their eligibility guards reject completed races. Effects themselves are not cached; final persisted totals are versioned by completion's final touch. |

The race-list stable fragment is not trusted as the result version. When that
fragment comes from Redis, `findSqlSummariesForUser` re-reads authoritative
`Race.status` and `Race.updatedAt` in its existing membership-validation query
and overlays both before deriving completed-summary keys. Consequently, a stale
per-user list fragment cannot keep an older shared-result key reachable.

Operational SQL and one-off repair scripts are outside the runtime writer set.
Any repair that changes a completed race participant's status, user ID, team,
forfeiture, totals, finish time, placement, or payout must update the owning
`races.updated_at` in the same transaction. Wildcard Redis deletion is not an
acceptable substitute; old versioned values expire naturally after 30 days.
