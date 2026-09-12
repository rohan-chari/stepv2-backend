# Leech expiry fix

## Behavior

A Leech's actual transfer is saved once in effect metadata as `leechFinalV1`,
including zero. Both its debit and credit are then immutable. Later walking
cannot use leftover stealing potential; later Health corrections cannot claw
back the credit. The victim's displayed score remains floored at zero, and
incoming Leech credits remain non-drainable.

New transfers use the earliest of effect expiry, race end, or either player's
finish/forfeit. Timestamped samples are clipped to that cutoff, including the
eligible portion of an overlapping bucket. A delayed worker does not extend
eligibility. Daily-total-only victim balances, net bonus changes, and already
awarded coarse Hitchhike contributions have source-transaction checkpoints;
later source writes cannot increase those checkpointed balances.

Previously expired effects have no reconstructed checkpoint. The deployment
command freezes their current actual allocations, as explicitly requested.
The previously observed cohort was 41; deployment enumerates the then-current
eligible IDs and reports every amount or skip instead of assuming that count.

The old client duration remains 30 minutes; `powerups3` clients retain 60
minutes. This is a backend-only fix with no API field removal, required client
parameter, app release, or rollout flag. Daily race-result caching is deferred.

## Implementation and work added

The additive `leech_expiry_checkpoints` table has three rows per new live
Leech: daily inputs, net bonus, and awarded Hitchhike captures. Separate rows
avoid reversing the intake-user / race-worker lock order. Leech casts acquire
the victim's existing intake lock before C0, so checkpoint initialization sees
an in-flight sync after it commits. Triggers participate in source transactions
and stop admitting inputs at the deadline or permanent final stamp.

A sync adds no application SELECT or network round trip for this checkpoint.
Its daily write can update one indexed checkpoint row per still-live Leech on
that user; bonus and Hitchhike writes update their separate source rows. This
is additional database work, bounded to live links. At first finalization,
boundary scoring loads the victim's eligible inputs and saves one effect
metadata update. Subsequent scoring reads the fixed amount and skips that
Leech's sample-window and boundary reconstruction. These are code-path counts,
not a production benchmark.

Full, incremental, live, uploader reconciliation, forfeit, and settlement
scoring consume the same fixed amount. Read-only paths discard metadata writes;
the queue captures them and commits through its existing C0/input fence.
Settlement validates its source fingerprint before committing new finals.
Forfeit computes both sides without firing unrelated Drill/Trail Mine
consequences, then freezes its participant under the existing C0 transaction.
Fixed credits survive a victim's forfeit without re-debiting their frozen score.

Unresolved checkpoints enter the fingerprint only once their cutoff is reached.
Live Hitchhike capture refreshes cannot invalidate their own worker generation.
A database trigger preserves an existing final stamp even if an older writer
replaces unrelated metadata. Checkpoints remain race-owned diagnostic source
records and cascade with effect deletion; final amounts live in effect metadata.

## Focused verification

Dedicated local database: `bara_event_ordering_test` on localhost. No integration
suite or migration ran against production. Focused HTTP/worker coverage includes:

- zero and positive expiry balances, delayed scoring, start-day clipping, and
  an overlapping sample bucket;
- daily-only input, net bonus checkpoints, and post-expiry source corrections;
- old-client duration, active and expired forfeits, and early race ending;
- recursive expired transfers reserving prior debits;
- the actual queue commit saving a final amount before any progress GET;
- a deterministic concurrent cast/sync with the blocked DB writer observed;
- legacy command preview rollback and applied transfer, followed by live and
  settlement parity after later walking/corrections.

Existing Leech granularity and Hitchhike settlement tests remain in the focused
verification set. Pure full/incremental arithmetic and prefetch tests supplement
these HTTP tests. The huge full integration suite and Flutter builds are not
needed for this backend-only change.

## Production procedure — requires separate deployment approval

1. Read the normal deployment runbook, record the current release, and prepare
   the verified checkout/dependencies. Keep the existing two HTTP workers and
   configured background topology; staging stays stopped.
2. Briefly stop **all application writers** (HTTP, cron and resolution/post-task
   workers) and let in-flight transactions finish. Keep them stopped through
   migration and legacy initialization. This preserves a single current legacy
   balance and avoids migration table-lock inversions during active writes.
3. Apply migration `20260912210000_leech_expiry_checkpoints`. It is explicitly
   transactional: source-table trigger locks remain held through active-only
   checkpoint backfill. Generate the Prisma client for the release.
4. Run `node scripts/freeze-legacy-leech-transfers.js` for a preview. It executes
   inside a rolled-back C0 transaction, including incidental Hitchhike refreshes.
   Inspect its per-ID amounts and skip report.
5. Run `node scripts/freeze-legacy-leech-transfers.js --apply`. It processes
   keyset batches of 100 IDs and commits one race at a time through C0. Applied
   rows are reported only after transaction commit. A skip produces exit code 2
   and must be investigated before calling initialization complete. Rerun the
   preview to verify no eligible unresolved legacy effects remain.
6. Restart the existing production topology and verify health, queue progress,
   representative frozen scores, and migration status. No capacity change.

The additive database schema can remain if application rollback is needed, but
old application code does not honor the frozen transfer contract. Prefer a
forward fix after any immutable finalization has been persisted. Do not erase
final stamps or rebuild them from corrected source data.
