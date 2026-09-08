# Race locks and independent powerup concurrency

Research date: 2026-09-08. Reviewed original release `3b241ff`, participant-lock
branch `9b2cfb8`, and relevant unchanged code in main `ba6cfc3`. This is research
and a proposed test direction, not an implemented concurrency change. No
production observations or latency measurements were collected for this audit.

## Finding

Independent same-race powerups can plausibly run concurrently, but the current
participant-lock patch does not enable that. A candidate is **shared race guards
for audited participant-scoped commands, exclusive race guards for broad writers,
and exclusive locks on the actual participant/effect dependencies**. This can
retain the current direct HTTP interface; it does not require a command queue.

Do not implement it by changing two lock strings and calling it complete. The
targeted handler currently relies on exclusivity before its participant locks,
and several other writers coordinate on the same rows through different helpers.

## What the locks actually are

The default use command opens one transaction and acquires, in order:

1. `race_resolution_jobs_v2` row for the race, `FOR UPDATE` through C0.
2. `races` row for the race, `FOR UPDATE`.
3. The selected `race_powerups` item row.
4. Participant rows, then affected defense/effect rows.

These first two locks are on **individual database rows**, not table-wide or
database-wide locks. They serialize cooperating writers for that race. Ordinary
unlocked reads can continue; another race normally has different guard rows.
Locks last until transaction end. HTTP may subsequently wait on after-commit
callbacks even though the gameplay locks have already been released.

Source: [use wrapper, including both guards](https://github.com/rohan-chari/stepv2-backend/blob/9b2cfb8/src/modules/powerups/commands/usePowerup.js#L4845),
[C0 implementation](https://github.com/rohan-chari/stepv2-backend/blob/9b2cfb8/src/modules/races/models/raceResolutionJobV2.js#L1563).
PostgreSQL documents row-lock conflicts and transaction lifetime in its
[explicit-locking reference](https://www.postgresql.org/docs/18/explicit-locking.html#LOCKING-ROWS).

Removing either guard alone leaves the other serializing independent uses.
Changing exclusive row locks to `FOR NO KEY UPDATE` also leaves writers mutually
exclusive. `FOR KEY SHARE` is too weak as a general replacement: it permits
non-key updates such as status/generation changes. `FOR SHARE` holders coexist
but conflict with row updates. These distinctions are supported by PostgreSQL's
[row-lock compatibility table](https://www.postgresql.org/docs/18/explicit-locking.html#ROW-LOCK-COMPATIBILITY).

## What C0 protects in this architecture

| Path | Actual coordination | Why it matters |
| --- | --- | --- |
| All direct powerup use | C0, race row, item, participants/effects | Inventory consumption, defense/jam ordering, step transfers and receipts commit together. |
| Scoring worker commit | `jobModel.acquireForWrite` with expected lease token | Checks ownership and source fingerprints before applying a computed score. Removing its exclusion can permit stale writes. |
| Placement worker | `lockResolutionGeneration`, directly `FOR UPDATE` on the job row | This path also participates in C0 even though it does not call `acquireRaceWriteFence`. |
| Settlement, cancel, expiry, forfeit, membership/team changes | C0 and their lifecycle/membership locks | Admission, race status, recipients and payouts cannot change halfway through a use. |
| Admin commands, effect-deadline dispatch, snapshot repair | C0 through several model/helpers | A caller-name search alone is not a complete lock audit. |
| Step intake and global-event work | Queue-row inserts/updates; global-event paths also acquire C0 explicitly | Even an implicit SQL row update conflicts with a shared guard. Step intake is not the same as the scoring worker commit. |
| Effect expiry | Individual effect locks; Fanny expiry additionally takes race then participant locks | Not every effect writer uses C0. Existing effect-row revalidation remains necessary. |

Relevant source: `raceResolutionQueueV2.js:2004`,
`racePlacementTransitionWorker.js:96`, `racePlacementBaseline.js:115`,
`raceWriteFence.js`, `raceJoinLock.js`, `completeRace.js`, `raceExpiry.js`,
`raceEffectDeadline.js:47`, and `expireEffects.js:138` (line anchors on `9b2cfb8`).

The worker already does expensive computation before its write transaction.
Its remaining guarded work includes source validation and writes. This proposal
does not make scoring commits concurrent with arbitrary powerups; their ordering
still needs protection. Queue generation alone is not a sufficient correctness
argument when post-commit enqueue and command effects can become visible at
different times. Retain/audit canonical source fingerprints as well.

## A real use for the existing participant-lock patch

There is a concrete default code path outside C0:

`usePowerup` after commit → `repairRacePowerupInventory` →
`RaceParticipant.updateMaxBonusSteps` → one participant `UPDATE`.

If player D's repair is updating that row, A's Shortcut on B previously tried
to lock D along with the entire roster. Narrowing the lock set avoids that
unrelated conflict. `discardPowerup` also calls `syncRacePowerupState`, whose
non-transactional repair branch can update the participant high-water mark.

This is **source-confirmed reachability, not measured production frequency**.
These are normally small writes; there is no evidence they routinely hold a row
for the artificial 500 ms used in the earlier test. The patch still does not let
A→B and C→D direct commands overlap their mutation transactions.

Sources: `usePowerup.js:1210`, `racePowerupInventoryRepair.js:53`,
`racePowerupStateSync.js:105`, `raceParticipant.js:548`, `discardPowerup.js`.
Do not count every apparently unfenced helper as a live benefit: the placement
worker takes C0 through another model; `reconcileUploaderRaces` is exported but
this search found no production invocation; the legacy Fanny box auto-activation
branch is explicitly documented as unreachable from the current drop pool.

## Candidate protocol

For an explicitly audited local command, acquire **shared** guards on the
existing job and race rows, then exclusive item and ordered participant locks.
Existing exclusive broad writers will still conflict with those shared guards.
Using existing rows avoids introducing an advisory-lock protocol that older
workers do not know about. Mixed backend workers with old exclusive guards
would remain conservative; frozen mobile clients need no new request fields,
pending-job UI or changed success response.

| Concurrent operations | Intended behavior |
| --- | --- |
| A Shortcuts B; C Shortcuts D; complete dependency sets disjoint | Both can enter their mutation phase concurrently. |
| Both attack B, or reflection/redirection makes their sets overlap | Serialize on the overlapping participant/effect dependencies. |
| Shield activation on B and attack on B | Serialize on B, including the case where no shield row exists yet. |
| Signal Jammer on A and A uses a powerup | Serialize on A; repeat the jam check under the participant lock. |
| Outage versus any ordinary use | Outage retains an exclusive race guard, so one ordering commits. |
| Settlement/membership change versus a use | Exclusive lifecycle coordination preserves eligibility and recipients. |
| Scoring commit versus a use | Continue to exclude each other initially, with existing source-fence checks. |

The complete Shortcut dependency set is not invariably two users: actor,
original target, a possible Decoy redirect and applicable shields/reflection
state all matter. All participants in the dependency set are locked in deterministic order; a changed
plan must restart rather than append a lower-ordered lock.

### Required changes beyond guard modes

- **Revalidate all decisions after participant locking.** The current jam check
  (`usePowerup.js:1650`) occurs before targeted participant acquisition
  (`:2954`). A concurrent local Jammer could invalidate it. Current revalidation
  covers selected participant fields and consumed defenses, not every earlier
  jam, stealth, eligibility, timing and inventory decision.
- **Protect absent rows.** A query finding no shield cannot lock a nonexistent
  shield. Every insertion/consumption/removal path must coordinate through its
  participant or another agreed guard. Lifecycle/global exclusion alone does
  not serialize two shared local writers.
- **Prevent shared-to-exclusive upgrades.** A command cannot hold a shared C0
  lock and then synchronously update the same job row while a peer does likewise.
  Keep the existing post-commit enqueue outside that transaction for an initial
  compatibility experiment. If an atomic durable handoff is required, design an
  append-only handoff that does not upgrade the guarded row; the earlier queue
  experiment's unresolved trigger drain cannot simply be reused as proof.
- **Choose conservative fallback before writing.** Complex/global commands and
  uncertain dependency plans should use the exclusive path. If planning under
  shared guards discovers a broader need, roll back and reacquire in a fresh
  transaction. Retain the command's random choice appropriately across retries.
- **Keep independent safeguards.** Item consumption, shared-user wallet spends,
  foreign-key locks, effect expiry, source receipts, nested transaction behavior,
  end-of-race time checks and all implicit writes must be audited. A race guard
  does not replace these protections.

`FOR SHARE` on the job row also blocks queue-generation updates and worker
claims while uses hold it. Shared guards can therefore move contention rather
than eliminate it. Test worker/settlement progress under sustained shared traffic;
do not assume fairness or a production speedup from the lock compatibility alone.
If that shared queue-row hotspot remains material, a dedicated coordination row
separate from queue metadata is a larger follow-up design with an explicit
mixed-worker transition plan, not the first experiment.

## Local protocol check and next TDD tests

A disposable local PostgreSQL 16 database exercised seven `NOWAIT` checks using
three real connections and synthetic guard/player tables. It confirmed current
exclusive serialization, compatible shared guards with disjoint player locks,
overlap/global/lifecycle exclusion, and the weakness of `KEY SHARE`. It also
confirmed shared-to-exclusive upgrade conflicts. No timed sleeps or speedup
measurements were used. **This is SQL semantics evidence, not application
integration or gameplay correctness evidence.** Schema/database were removed
afterward; no production/staging data was accessed.

Script: `scripts/experiments/race-lock-protocol-probe.js`.
Results: `docs/race-lock-protocol-results.json`.
Set a dedicated localhost `steps_race_locks_research_test` URL on port 5432 to
reproduce; the script rejects other database identities and uses only its own
`lock_probe` schema.

The first application test should use real concurrent HTTP requests and an
execution barrier: A→B remains inside its transaction while C→D must reach its
own mutation point before A commits. It should fail on current code and pass
only when genuine concurrency exists. A shorter average request duration is not
a substitute. Then cover:

1. Same-target contention, shield insertion/consumption, actor jam, Mirror/Decoy
   redirection and plan changes, including expiry while waiting.
2. Both orderings against Outage, scoring commit, settlement and membership
   changes; no stale total overwrite, partial transfer or post-end consumption.
3. Duplicate item use, discard versus use, wallet spending across races and
   preservation of old-client responses/receipt identities.
4. Repeated mixed-load A/B tests with equal resources and counted outcomes;
   separate job-lock wait, race-row wait, participant/effect wait, critical-section
   duration and after-commit HTTP work. Include worker/settlement starvation and
   the real inventory-repair conflict instead of only a synthetic long row hold.

Recommended sequence: establish the real concurrency regression first, audit and
test shared guards on simple self commands, then enable Shortcut only after its
complete post-lock validation is correct. Keep global and unproven types
exclusive. This is a recommendation for a reviewed implementation, not a claim
that any race lock has already been changed.
