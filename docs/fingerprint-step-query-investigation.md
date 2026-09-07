# Fingerprint and step-query investigation — 2026-09-07

## Conclusion

The strongest next candidate is moving the race/participant JSON assembly in
`raceResolutionInputFingerprint.js` from PostgreSQL to Node. Keep the planning
and commit-fence reads and their exact digest semantics. No application code or
production data was changed during this investigation. The prototypes are not
a reviewed release and require new HTTP/worker integration coverage before use.

Reject the first per-user LATERAL step-sample rewrite: it wins strongly on the
synthetic dataset but regresses against the live database. Do not deploy it.
There is no evidence these candidates alone reach the 70% average idle target.

## Where the work happens

The resolution worker builds a fingerprint to plan a race calculation, then
re-reads protected inputs in its commit transaction. The comparison prevents
persisting a result based on inputs which changed during calculation. The
fingerprint includes four queries: race/participant JSON, input generations and
sample boundaries, effects, and global-event/entitlement boundaries. HTTP
artifact reuse also validates fingerprints. Removing the second read or caching
across input changes would weaken correctness.

Step prefetch reads participant sample ranges used by the scorers. It already
has a bounded process-local cache keyed by input generation and covered dates.
A changed generation invalidates that user's timeline; this investigation has
not measured the live cache miss breakdown. Existing HTTP/worker traces check
that identical user/time ranges are not repeatedly fetched within one attempt.

The five-minute production capture preceding this investigation recorded:
385 JSON fingerprint calls / 7.97 s execution; 177 sample calls / 90,421 returned
rows / 7.42 s; 396 event-fingerprint calls / 4.77 s. These are elapsed execution
totals, not query CPU percentages. The load is distributed across many queries.

## Fingerprint experiment

Isolated PostgreSQL 18 test database, guarded localhost and `_test` name.
Used the SQL observed from the real HTTP-to-resolution-worker fixture. The
prototype returns named typed columns from the same joined statement, preserves
participant ordering and the user presentation projection, then assembles the
original object in Node. Epoch numeric expressions use float8 to preserve their
JSON-number representation. Production source files were not edited.

Seven paired EXPLAIN measurements per roster size, medians in milliseconds:

| Participants | Existing DB execution | Typed-row DB execution |
|---:|---:|---:|
| 1 | 0.036 | 0.020 |
| 25 | 0.242 | 0.117 |
| 100 | 0.651 | 0.179 |
| 500 | 2.925 | 0.642 |
| 1,000 | 6.009 | 1.091 |

Exact payload equality held for these fixtures, including nulls, epoch dates,
team fields and Unicode names. Local query-transfer/Node-assembly/digest timing
was also measured (12 alternating repetitions); full digest equality held:

| Participants | Existing wall ms | Candidate wall ms | Existing Node CPU ms | Candidate Node CPU ms |
|---:|---:|---:|---:|---:|
| 25 | 0.805 | 0.804 | 0.436 | 0.624 |
| 100 | 1.607 | 1.344 | 0.585 | 1.286 |
| 500 | 6.681 | 4.746 | 2.795 | 4.091 |
| 1,000 | 12.468 | 9.075 | 4.916 | 8.145 |

The tradeoff is explicit: more Node CPU and repeated race columns on the wire,
less database JSON work. These local timings are not a production throughput
forecast or complete scoring-worker performance test.

Production SELECT-only validation used three current races of 10–14 members,
two paired EXPLAINs each. Every statement ran in an explicit read-only
transaction with a five-second statement timeout. No payloads or identifiers
were logged. Median execution: 15.23 → 9.45 ms; median planning plus execution:
28.34 → 21.61 ms. Both versions touched the same blocks for each race. Results
varied considerably under live load, and one candidate execution was slower;
this supports further testing, not a guaranteed 24% CPU saving.

## Step-sample experiment and rejection

Fixture: 25 users with 5-minute samples and 7/30/90 days of history, up to
648,000 rows. Reading the same one-day window (7,200 rows) took median
6.13 / 21.02 / 63.43 ms. This synthetic data distribution selected a full-table
scan. A per-user LATERAL query reduced the 90-day, one-day-window case to about
2.08 ms. Exact row parity held for 1/5/25 users, one/seven-day windows, including
a second page after the 50,000-row limit.

But the production query already selected `step_samples_user_id_period_end_idx`
and read only recent rows. The candidate's inner ordering selected
`step_samples_user_id_period_start_key`, filtering large amounts of older
history. For 25 users, the repeated warm comparison was 4.26 ms / 436 blocks
existing versus 52.74 ms / 3,756 blocks candidate. The candidate's first run was
even worse (~979 ms). This is a rejected hypothesis, not a production finding
of full-table scans. The live probe used recent one-day windows; it does not
characterize every real race window.

The first larger fixture insert hit its 20-second statement timeout inside the
existing durable capture journal trigger. Subsequent read-only performance
fixtures were populated with triggers disabled transaction-locally ONLY in the
isolated test DB. These synthetic SELECT experiments therefore make no claim
about HTTP ingestion or durable journal performance. Normal trigger behavior
was restored at transaction commit. The dedicated temporary DB was stopped
after the investigation; production and staging services were not restarted.

## Remaining work before a fingerprint release

Add tests first for complete HTTP/worker paths: individual/team races, empty
and populated rosters, both presentation modes, name changes, timestamp/null
encoding, concurrent input changes, artifact reuse and fence rejection. Compare
full digest and closure behavior, retain old-client responses, and measure the
complete worker at representative roster sizes. Do not weaken existing tests
which recognize fingerprint SQL; update their observation mechanism explicitly
if a new SQL projection requires it. Required code review and a fresh deployment
approval still apply before release.

The existing `query-efficiency-resolution.test.js:64` buffer-hit ratio assertion
again failed while generating this fixture on unchanged deployed code. That
known baseline benchmark failure remains; no assertion was removed or relaxed.

Evidence/prototypes: `/tmp/fingerprint-investigate.js`,
`/tmp/fingerprint-investigate.jsonl`, `/tmp/fingerprint-transfer-investigate.js`,
`/tmp/fingerprint-transfer-investigate.jsonl`,
`/tmp/sample-history-investigate.js`, `/tmp/sample-history-investigate.jsonl`,
`/tmp/sample-lateral-investigate.js`, `/tmp/sample-lateral-investigate.jsonl`,
`/tmp/sample-production-plans.jsonl`, `/tmp/fingerprint-production-plans.jsonl`.

## Implementation and review follow-up

Implemented on `perf/fingerprint-typed-rows` after user authorization. The
production change is confined to `raceResolutionInputFingerprint.js`: one
ordered typed-row roster query and Node object assembly. Schema 4, digest keys,
all four fingerprint reads, fence logic, and presentation-mode semantics remain
unchanged. There are no migrations, dependencies, flags or client API changes;
both frozen iOS and Android clients keep their existing response contracts.

Two new integration cases drive real HTTP uploads and the production worker
(individual/team). An observation-only preload records fingerprints without
substituting results or invoking the utility directly. Both cases failed on
the deployed source's JSON roster query before implementation. They now pass
legacy payload/full-digest parity, typed-SQL shape, scoring results, a subsequent
upload and an HTTP rename. Unit coverage adds missing/empty roster handling,
numeric/null encoding and presentation-mode scoring-digest parity; existing
mock raw rows were mechanically adapted to the changed SQL shape.

The existing 100-participant worker tests retain every assertion. Their
historical user-join benchmark now explicitly loads the frozen legacy SQL,
while their query observation recognizes the new typed shape. The separate new
integration suite asserts the production shape. Do not mistake that historical
benchmark for a fresh measurement of the typed query's performance.

Verification: 2 new HTTP/worker cases, 2 existing 100-participant worker cases
and 9 fingerprint unit tests passed. The initial combined run was 37/38: one
existing Redis stampede test reported two replays versus one. An isolated run
with unchanged deployed fingerprint code passed 25/25, and an isolated candidate
run also passed 25/25, with no skipped tests. The initial transient failure's
cause remains unproven, not an established baseline failure. The artifact
consumption, public step mutation between validation and fence, stale artifact
fallback, settlement and old response-shape cases passed. No test assertions
were weakened or skipped. The legacy buffer-hit benchmark passed on this run.

Code reviewer verdict: SHIP, no blockers or introduced issues; retain the
transient stampede caveat. Evidence: `/tmp/fingerprint-rows-red.log`,
`/tmp/fingerprint-verification.log`, `/tmp/fingerprint-baseline-redis.log`,
`/tmp/fingerprint-candidate-redis.log`. The dedicated test database is stopped.
Deployment and production measurement still require fresh user authorization.
