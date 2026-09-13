# Partial index operational rehearsal

Dedicated local PostgreSQL 18 test database; never production. `scripts/perf/parent-index-operations.cjs` records the reproducible procedure and raw evidence in the adjacent JSON files.

A concurrent build blocked by an open writer was cancelled with SQLSTATE `57014`. The catalog retained an invalid/not-ready index. Dropping that invalid artifact concurrently and rebuilding yielded the exact approved predicate with both `indisvalid` and `indisready` true. This exercises PostgreSQL artifact recovery, not an interrupted Prisma migration-ledger reconciliation.

Write fixture: 1,000 entitlement start updates followed by 1,000 end updates per variant, including real triggers; alternating baseline without the index and candidate with it. The initial ten pairs had a borderline maximum start-write regression. Thirty further paired runs provide the following evidence (nearest-rank p95):

| Measure | Baseline | Candidate |
| --- | ---: | ---: |
| Start update median | 29.1965 ms | 30.335 ms |
| Start update p95 | 35.551 ms | 37.328 ms |
| End update median | 22.8555 ms | 23.337 ms |
| End update p95 | 29.499 ms | 29.764 ms |
| Start root WAL median | 1,162,130 bytes | 1,246,261.5 bytes |
| End root WAL median | 1,052,046.5 bytes | 1,053,282 bytes |

Start-write p95 increases 4.99845%, effectively at the specified 5% material-regression threshold; this is marginal evidence, not a robust production acceptance result. End-write p95 increases 0.898%. Start root WAL increases about 7.24% at the median. Root WAL excludes trigger subplans; timings include triggers. The shared local cluster and evolving table state limit interpretation. The recorded 8,192-byte index size is after draining the fixture, not a populated-index capacity estimate.

The separate read fixture demonstrates large buffer savings, but production rollout must still weigh observed write/WAL overhead against actual read frequency and retain the specification's pending-heavy/concurrent-boundary validation gates. No production latency or CPU saving is claimed.

## Controlled follow-up

Other implementation tests were actively using the shared PostgreSQL cluster during the measurements above. All other database test work was therefore paused, with no other client sessions observed, before a further fixed 30-pair replay. Results are in `parent-index-operations-controlled-30.json`:

| Measure | Baseline | Candidate |
| --- | ---: | ---: |
| Start update median | 27.145 ms | 28.195 ms |
| Start update p95 | 34.061 ms | 34.994 ms |
| End update median | 23.3385 ms | 21.0755 ms |
| End update p95 | 27.985 ms | 27.297 ms |
| Start root WAL median | 1,161,648 bytes | 1,244,513 bytes |
| End root WAL median | 1,051,904.5 bytes | 1,052,309.5 bytes |

Controlled start-write p95 increases 2.739%; end-write p95 decreases 2.458%. This meets the local 5% latency threshold in this fixture. The roughly 7.13% additional start-write root WAL remains a measured cost; the uncontrolled runs are retained rather than discarded. Concurrent-build cancellation and exact valid/ready recovery also passed again.
