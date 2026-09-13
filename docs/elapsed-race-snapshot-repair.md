# Elapsed race snapshot repair

An ACTIVE race can pass its end time before the settlement job marks it completed.
Live scoring deliberately returns no result in that interval. Previously its post-task
publication failed with DISPLAY_PROOF_MISSING, and repair admitted another
DISPLAY_REFRESH because it checked status without checking end time.

## Change

- Repair retires an obligation when status is inapplicable or ends_at has passed,
  using PostgreSQL UTC time. Existing failed tasks are covered without migration.
- A skipped scoring result for an ACTIVE elapsed race creates no snapshot command
  when there are no expiry consequences or notification claims to retain.
- Durable effect-expiry tasks remain intact. After their consequences execute,
  missing-proof publication recognizes settlement ownership and uses the existing
  skipped_superseded outcome instead of generating another repair obligation.
- Normal live generations incur no additional read. The new primary-key lookup
  runs only for missing results/proofs. No Redis keys, flags, API changes, or schema
  changes are introduced. Existing iOS and Android clients use unchanged responses.
- An end boundary crossed after the repair check may admit one redundant job;
  the worker guard prevents that from becoming an endless chain.

## Tests and measured result

Tests were added before business logic and run only against loopback PostgreSQL
bara_midnight_repair_test with disposable local Redis. The first red run reproduced
repair generation advancement and one failed publication. With the fix:

1. An existing failed publication on an elapsed ACTIVE race retires without a new
   generation across three recovery/scheduler ticks.
2. A due effect still expires, with zero failed publication tasks or pending repairs.
3. Display-only work produces zero post tasks and zero receipts across three full
   scheduler/worker/post-task passes; the real settlement job subsequently completes
   the race and progress remains available over HTTP.
4. Future-ended races still repair and publish a successful snapshot.
5. Open-ended races still repair and publish a successful snapshot.

All five new tests pass. Code reviewer: no blockers or remaining issues.
Flutter analyze --no-pub: no issues.

The broader four-file integration run passed 43/48 tests. Five failures were also
observed before the implementation in the existing race-effect-expiry-cache suite:
completed/cancelled/pending historical failure lookup expectations, delayed older
Redis snapshot write interception, and COMPRESSION_SOCKS successful-publication
assertion. Existing tests/assertions were not changed or skipped. The publication,
Leech-boundary, and settlement-parity suites passed. This is not a fully green
regression run; the baseline failures remain unresolved.

Local evidence logs: /tmp/bara-midnight-red.log, /tmp/bara-midnight-baseline-full.log,
/tmp/bara-midnight-five.log, /tmp/bara-midnight-regression.log, and
/tmp/bara-midnight-flutter-analyze.log. These are ephemeral local logs, not production
measurements. Production CPU savings remain unmeasured; this change has not been
deployed. Removing the observed repair chain does not establish its exact CPU share.
