# Final event validation reuse

The race resolution worker previously loaded the complete event history twice:
once while planning (possibly from Redis v4), and again in the final write
transaction. The historical monitor attributed 3,606 calls, 50.7 seconds and
4.80 million buffer accesses to full event history/final validation. Those are
historical workload totals, not a prediction of the savings from this change.

The worker now retains a private, attempt-local copy of the complete verified
planning vector. Final validation folds the deployed database event proof into
its existing roster SELECT. If race identity, catalog revision, database epoch,
race version/incarnation, cursor and race start still match, it materializes
that vector at the final clock and lookahead. PostgreSQL remains authoritative.
No additional Redis cache, Redis round trip during final validation, migration,
feature flag, API change or mobile release is required.

The vector includes the existing cache's extra lookahead coverage, not merely
the events visible at planning time. An event entering the ten-minute horizon
therefore changes the final fingerprint and rejects an outdated plan. A crossed
start/end boundary, expired snapshot, backward clock, insufficient coverage or
changed proof causes the original SQL query to run inside the same transaction.
A missing/invalid proof or unavailable Redis planning read retains the original
SQL path. A failed Redis write does not invalidate successfully verified DB rows.

Snapshots are private WeakMap entries keyed by object identity, bounded to the
existing 8,192-row and 2 MiB limits and at most 30 seconds. Caller-visible rows
cannot mutate the retained vector. They are discarded with the attempt; no
serialized artifact can supply provenance. Retry paths clear the planning
fingerprint. Accepted display artifacts use the current attempt's validated
fingerprint, and source-input, artifact and closure fences all retain their
existing digest, generation, balance and deadline checks.

This preserves the existing transactional isolation model; it does not add
serializability against writes occurring after the final SQL statement's
snapshot. It removes redundant data loading rather than weakening the existing
version or scoring fences. Old iOS and Android clients receive unchanged shapes
and scores.

## Validation

Tests first: the two new global/local unchanged-vector integration tests failed
on the original implementation because each final read still queried history.
With reuse, measured fingerprint SELECT counts are cold [4 planning, 3 final]
and warm [3 planning, 3 final], versus the previous [4, 4] and [3, 4]. Final
history SELECT count falls from one to zero for admitted unchanged attempts.
This is one fewer database round trip per qualifying final validation; fallback
still performs four reads. Whole worker totals vary with secondary work and
must not be inferred solely from fingerprint counts.

Integration tests use only a dedicated loopback PostgreSQL `_test` database
and dedicated loopback Redis. Coverage includes raw old-writer mutations,
Redis errors, precision guards, time boundaries, moving lookahead, expiry,
private-copy isolation and persisted score parity through the HTTP endpoint.
Existing assertions requiring unconditional final history loading were updated
explicitly for the new version-fence contract; score and mutation rejection
assertions remain in place.

Final local results: 53 event-cache tests and 11 planning-input tests pass;
Flutter analysis passes; code review reports SHIP with no blockers. The three
core artifact tests pass (consumption, missing artifact, concurrent step input).
The broader closure run passed 16/21; all five failures were reproduced on
unchanged code. The actor-target fixture varies between runs because its worker
claim is not restricted to the fixture race; an isolated baseline repeat also
failed. The two additional artifact failures likewise reproduce on unchanged
`01f7c20`. These existing failures remain unchanged; the broader suites are not
claimed green. No production deployment or production CPU measurement was made.
