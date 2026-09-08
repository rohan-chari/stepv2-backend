# Global-event enrollment query: measured before/after

The implementation changes only the candidate SELECT in
`src/modules/steps/services/globalStepEventEntitlement.js`. API requests,
responses, errors, schema, scalar timezone preparation, enrollment transactions,
durable event production and scheduler budgets remain unchanged. Old iOS and
Android binaries use the same contracts. The implementation validation below was local only. Production release
observations are recorded separately in the production deployment report.

## Measurement method

All data is synthetic in a dedicated local PostgreSQL **18.4** database ending
in `_test`. The harness rejects any other hostname, a missing test database
name, anything except explicit `NODE_ENV=test`, and anything except explicit
`REDIS_URL=` **before** importing `src/db`/dotenv. Local Redis is disabled.
Existing migrations and identity-search indexes were applied only to this
disposable database. No new schema migration or index is part of this change.

The public `buildLocalGlobalStepEventTick` from `src/modules/steps` runs the real
materializer, generation census, transactional enrollment, event append and
receipt logic. Only clock and logging are controlled. Functional pagination
freezes both business time and `Date.now()`; timed runs keep the actual
five-second budget. A separate authenticated HTTP case runs the public
boundary drain and checks `/races/:id/progress` for legacy and current
`X-Client-Features` headers.

Query events capture the real SELECT and bound parameters. Before paired plan
measurements the entire fixture is restored to its **pre-tick** state and
ANALYZE runs on the four fixture tables. Baseline, candidate and captured SQL
must return exactly the same ordered rows. Each combination has a warmup and
five measured baseline/candidate pairs in alternating order. `EXPLAIN
(ANALYZE, BUFFERS, FORMAT JSON)` runs only on these SELECTs.

The reported buffer measure is the root plan's shared hits plus reads;
descendant buffers are never summed. Planning and execution samples, actual
rows/loops by relation, temp blocks, output rows and real workflow query counts
are retained in the JSON evidence. These are database-work and elapsed-time
measurements, **not host CPU measurements**. No `pg_stat_statements` reset was
needed. The script records source/SQL SHA-256 hashes as well as git HEAD so
uncommitted baseline/candidate source can be distinguished.

`leadingSqlVerbs` counts emitted statement prefixes, including `WITH` separately.
It is not a count of affected tuples or all internal writes: a data-modifying
CTE can contain several writes. Entitlement and durable-obligation counts are
separately read from PostgreSQL. First-tick and final/converged counts are
explicitly distinguished; cumulative times exclude fixture setup, EXPLAIN,
verification queries and the natural wait until the next cron minute.

## Fixtures and gates

The audit-shaped fixture has 30,000 historical accepted memberships in 600
completed races, 2,500 memberships in 160 active races, and 1,000 distinct active
users. IDs are deterministic UUID-shaped hashes that interleave historical and
active users. Historical-only users never qualify; duplicate active memberships
must not consume page slots.

Cases cover zero missing, 25 missing, all 1,000 missing, history increased to
300,000 memberships with the active population fixed, and 10,000 active users
with 25,000 active memberships. Three-active-race empty/full/10,000-user controls
retain a topology in which the baseline can already be efficient. Each case
uses page sizes 100 and 500 with null and middle-of-population text cursors:
**32 combinations**, five measured pairs each.

The audit-shaped historical empty cases require at least 75% median buffer
reduction. Other cases allow no more than 20% regression. Already-efficient
three-active-race controls use the non-regression gate; requiring 75% savings
from an already-optimal baseline would manufacture a failure. No threshold was
weakened to accept a candidate. Timing regressions and new temp spills require
explicit review independently of buffer gates.

## Tests first

Before editing application SQL, seven functional/public-workflow cases passed
and only the new work-budget assertion failed: **35,097 shared-buffer accesses
against a fixed 8,000 budget**. The performance target was chosen after observing
the unchanged query on the audit-shaped fixture. The original fully materialized
candidate subsequently passed all eight tests, using 748 buffers.

The cases cover all race/membership exclusions, duplicate memberships,
other-event entitlements, terminal empty pages after exactly 500 candidates,
601 candidates, zero-created full-page progression, exact start time, invalid
timezone fallback, repeated ticks, a newly eligible lower-sorting ID,
generation-ready/not-ready behavior, concurrent producers and HTTP visibility.

One initial test expectation was corrected openly: two simultaneous scheduler
producers do **not** both necessarily succeed on the unchanged implementation.
The existing insertion statement can reject the loser with
`set-based entitlement materialization found conflicting immutable facts`.
The regression preserves that specific error and proves the next public retry
converges to exactly one entitlement/obligation per event/user. No production
write/locking semantics or existing protected test assertion was changed.

## SQL alternatives and timing limits

The original `active_users AS MATERIALIZED` candidate passed all 32 buffer
gates with no new temporary-file spill. Representative initial paired medians
for 500 rows and null cursor:

| Fixture | Baseline buffers | Candidate buffers | Baseline execution | Candidate execution |
| --- | ---: | ---: | ---: | ---: |
| 30k history, no missing users | 35,097 | 748 | 8.237 ms | 3.179 ms |
| 300k history, no missing users | 321,667 | 6,697 | 101.401 ms | 13.274 ms |
| 1k active users, all missing | 19,160 | 1,261 | 7.956 ms | 6.863 ms |
| 10k active users, all missing | 5,459 | 1,904 | 5.542 ms | 15.951 ms |

The 10k dense case exposes a real tradeoff: grouping/materializing all active
users prevents the baseline's early stop. Fewer buffer accesses do not imply
less execution time in every workload. A newly full cohort has more expensive
pages even though empty maintenance and history growth improve substantially.

One initial real 10k full-cohort trial completed 20,000 entitlements/obligations
in a baseline tick of 4.901 s, while the candidate created 19,500 in 5.029 s and
required another 152 ms tick for the last 500. A natural scheduler would wait
until the next minute for that followup; an immediate benchmark retry does not
erase this potential delay. Three additional alternating real-source trial
pairs found both versions required two ticks in every run:

| Trial | Baseline first-tick entitlements | Candidate first-tick entitlements | Baseline cumulative time | Candidate cumulative time |
| --- | ---: | ---: | ---: | ---: |
| 1 | 19,500 | 19,500 | 5.238 s | 5.183 s |
| 2 | 16,000 | 13,500 | 6.216 s | 7.093 s |
| 3 | 12,500 | 12,000 | 7.515 s | 7.549 s |

All runs converged to exactly 10,000 entitlements and corresponding new
obligations per parent. Whole-workflow write cost varied considerably on the
local machine; these trials do not establish a guaranteed dense-throughput
improvement or neutral production capacity.

Three bounded alternatives were evaluated and retained as rejected evidence:

- Materializing active race IDs alone produced a 212.5 ms empty page at limit
  100 and failed the 75% gate.
- `active_users AS NOT MATERIALIZED` improved some dense timings, but the full
  matrix restored the original bad plan at 300k historical memberships:
  321,667 buffers for both baseline and candidate. It failed all four required
  history-growth combinations and cannot replace the materialization fence.
- Per-active-race `LATERAL` top-K selection preserved ordered result parity but
  used 15,124 buffers against 5,564 baseline buffers on a 10k cursor page,
  violating the 20% non-regression gate.

No adaptive branches, new indexes, flags, caches or scheduler changes were
introduced to hide these results.

## Reproduction and evidence

Use a newly migrated dedicated PostgreSQL 18 database and explicitly provide:

```sh
export DATABASE_URL='postgresql://local_test_user@127.0.0.1:55438/enrollment_query_test'
export NODE_ENV=test
export REDIS_URL=
export SESSION_TOKEN_SECRET=enrollment-test-only
export REFERRAL_IP_HMAC_ACTIVE_VERSION=1
export REFERRAL_IP_HMAC_SECRET_V1=integration-test-only-referral-hmac-secret-material
node --test --test-concurrency=1 --test-force-exit test/integration/global-event-enrollment-query.test.js
node scripts/perf/global-event-enrollment-query.js --phase after --output /tmp/enrollment-after.json
```

For baseline workflow measurements, run the same script with the original SQL
installed at the existing seam and `--phase baseline`; the script rejects a
phase/query mismatch. `--workload large-active` selects the dense repetition.
There is no application switch between queries. The frozen original SELECT is
stored only in `test/integration/fixtures/enrollment-query/baseline.sql`.

Sanitized evidence lives under `docs/evidence/global-event-enrollment-query-*`.
`red.json` and `green.json` retain tests-first work measurements; `before.json`
retains the original-source workflow and paired plans; `full-materialized-after`
and `repeat-*-baseline/after` retain the original candidate trials;
`active-races-probe`, `not-materialized-probe`, and `lateral-probe` retain the
rejected alternatives. All user IDs in these artifacts are synthetic.

## Final selected implementation and regression results

The architect accepted the **original MATERIALIZED active-user CTE**, after
reviewing all alternatives and the timing tradeoff. Its exact selected source
SHA-256 is `015eda3d1a45dfffba27496124151d7676cd5d25b00f87a77b723b594b4405d1`.
The [canonical selected after evidence](evidence/global-event-enrollment-query-after.json)
has all **32/32 paired-plan gates passing**, exact ordered row parity and no
new temp-file spills. The [before evidence](evidence/global-event-enrollment-query-before.json)
contains the real original-source workflow. The failed NOT MATERIALIZED full
matrix is retained separately in
[rejected evidence](evidence/global-event-enrollment-query-not-materialized-rejected.json).
Hash enrichment/derived totals added after early runs are explicitly labeled;
raw timing samples and observed counts were preserved.

Current-scale empty maintenance retained 18 observed statements before/after
and improved one measured full tick from 31.954 to 21.812 ms. The 10x-history
case retained 18 statements and improved from 265.616 to 37.568 ms. This change
reduces work inside the existing SELECT, not network round-trip count.

Final targeted integration results are **70/73 passing**: new enrollment-query
suite 8/8, existing real-cron query-efficiency 1/1, existing local-entitlement
suite 27/29, existing reliability suite 34/35. The Home-cache test requires
`LOCAL_REDIS_TEST_URL` as well as `REDIS_URL`; with both pointing at an isolated
local Redis db15 that cache test passed. Three existing integration failures
were reproduced with the original SELECT restored, on the same local database
and Redis setup:

| Existing test | Failure unchanged on baseline and selected SQL |
| --- | --- |
| Reliability: concurrent STEP_SYNC reason/scopes merge | Expected `IMMEDIATE`, received `COALESCE`. |
| Local entitlement: active event dependency closure | Expected `FULL`, received `DEPENDENCY_CLOSURE`. |
| Local entitlement: HTTP display artifact end fingerprint | Expected multiplier 1 after expiry, received 2. |

Focused existing unit suites are **31/34 passing**: both scheduler suites pass
18/18; `localGlobalEventEntitlement.test.js` passes 13/16. Its three materializer
cases inject Prisma doubles without `$queryRawUnsafe`, which the unchanged
baseline already requires. All three failures reproduced with the original
SELECT; no mock or assertion was weakened. Those internal page-contract
assertions remain failing in the pre-existing suite, while the new public
scheduler integration cases cover pagination and durable writes end-to-end.

No full test-suite green claim is made. Full `npm run test:integration` and
full unit sweeps were not repeated after these targeted baseline failures.
Application behavior outside the approved SELECT seam was not changed to fix
unrelated regressions. Sanitized regression counts and baseline proof are in
[validation evidence](evidence/global-event-enrollment-query-validation.json).
Both mobile platforms retain the same API behavior; the orchestrator ran
Flutter analysis and existing global-event banner widget tests separately.
Production deployment was explicitly authorized after this local validation;
local plan timings cannot establish a database CPU target.

The isolated PostgreSQL and Redis processes were stopped after validation;
connection checks confirmed both test ports closed. Synthetic local cluster
files were retained for reproduction.

## Exact production-base release validation

The release was assembled on production base `030aebdfa9d5843794ad0a09549a855c238ed67a`,
with only the reviewed SELECT change and its tests/evidence. The eight new
integration tests passed again on isolated local PostgreSQL 18.4. The empty-page
comparison used 35,099 baseline buffers versus 748 candidate buffers. No API,
dependency, schema, ecosystem configuration, or mobile source changed.
