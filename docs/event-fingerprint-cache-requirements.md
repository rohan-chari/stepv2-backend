# Event fingerprint cache requirements

Production integration note: runtime `393edb4` uses deployed recap baseline
`ee86200`. Preserve that baseline's event vector, which omits retired impact
status and summary-attribution fields. The earlier implementation baseline
below is historical; see `event-fingerprint-cache-production-release.md`.

Implementation authorized September 11, 2026; baseline 136e682 includes receipt
recovery. This refinement supersedes the timestamp completion-marker proposal.

## Outcome and scope

Reuse exact event vectors for protected worker planning, validated by PostgreSQL
revision witnesses. Completed events remain available for historical scoring and
delayed samples. No completion table or per-sync marker is needed. The saved work
is repeated event discovery and payload loading.

Production race display misses serve committed state. The alternate request
replay branch is not the production trigger. Final transaction fingerprints,
settlement, expiry and capture completion retain their canonical PostgreSQL paths.

No client API, capabilities, multiplier, timezone policy, powerup, payout,
notification or step semantics change. Frozen iOS/Android clients keep the same
responses. No Flutter changes or app builds are required.

## Evidence correction

The earlier 614-call/1.9-second report used a moving ten-minute query filter and
misaligned CPU samples. It is not a valid five-minute performance baseline.
Per-branch costs and execution plans were not obtained. Measure savings anew.

## Persistence and migration

Add a database-owned catalog revision covering all parent event definitions,
including local parents. Database triggers advance it transactionally, covering
old backend writers. Add row-local revision stamps to entitlements and impacts.
Use additive constant-default columns rather than updating existing terminal
impact rows. A complete witness set detects insertions and deletions.

Do not increment a shared global/race/user counter on each local mutation.
Triggers must not acquire new C0 locks. Parent catalog mutations are rare;
cursor lease churn must not reload unchanged catalog definitions. Read the
current cursor tuple directly. Verify/add a race-leading impact index.

Install additive schema before readers. Old code continues using canonical
queries. Missing revision state must fall back safely, without aborting an
existing scoring transaction to probe migration availability. No release flag.

## Read protocol

1. Explicitly admit caching only in protected worker planning; final transaction
   reads and all unadmitted callers use canonical SQL.
2. Fold catalog revision, race identity/start, current cursor tuple and a complete
   bounded impact/entitlement ID-and-revision witness into an existing fingerprint
   read where practical. The local set is impact-based: do not add an accepted
   participant filter that is absent from the original SQL.
3. Separate scoring Redis keys from display keys. Keys identify schema, database
   epoch/identity, catalog revision and coverage. Local keys also identify race
   start and complete witness digest. Negative local results require the same
   authoritative witness validation.
4. Reuse a complete validated vector, preserving historical data and future events
   through now plus ten minutes. Never interpret completion as an empty vector.
5. Fills return data plus their own witnesses from the same SQL snapshot. Never
   attach an earlier witness to later data. Version-specific keys prevent a late
   old fill masquerading as current data.
6. Final pre-write transaction reads execute the original event SQL. Existing
   fingerprint comparisons/retries reject stale planning. This preserves the
   existing guarantee, not new serialization against every possible writer.

## Redis contract and exact semantics

PostgreSQL is authoritative; Redis stores reconstructible event vectors.
Declare coverage start/end and bounded row-count, byte-size and TTL constants.
Coverage extends beyond the caller's ten-minute lookahead to permit reuse.
Out-of-coverage, oversized, malformed, stale or unavailable data uses SQL.
TTL controls storage/reuse, not correctness; database witnesses certify freshness.

Validate schema, identity, revision, coverage, dates, nullable fields, finite
multipliers and full row shape. Preserve SQL row multiplicity and ordering.
If JavaScript cannot reproduce timestamp precision or collation for an input,
bypass rather than silently round or reorder it.

Compute boundary status from current cursor and caller time. Preserve predicates:
ends_at > race.started_at; starts_at <= horizon; boundary_at <= now; cursor
ordering (boundary_at,event_id,boundary_kind). Preserve persisted local windows,
activation outcomes and revisions; never recompute from current user timezone.
Empty local data does not erase legacy global events.

Redis failure uses the canonical query. No new cron, queue or per-step
invalidation job is needed. Aggregate bounded metrics only; no raw identities,
credentials or step payloads in logs.

## Implementation order

Backend developer owns migration/schema, event read/cache services, explicit
worker planning admission, fingerprint wiring, cache keys, metrics and tests.
Main owns specification/validation notes. Frontend developer verifies unchanged
API/platform behavior and analysis. No unrelated concurrent files are edited.

Keep shared GlobalStepEvent.findActiveInRange and settlement/capture behavior
unchanged. Database triggers cover source writers without rewriting concurrent
receipt and entitlement code. Run architect/scoring and final code reviews.

## Tests first and acceptance

Use dedicated local _test PostgreSQL plus isolated Redis. New tests fail for
missing behavior before implementation. Exercise real HTTP intake, the actual
resolution worker and public progress outcomes; do not replace these with direct
internal-helper assertions. Pure date math and source guards may use unit tests.

Required cases: cold/warm/no-Redis parity; completed event plus delayed/replacement
samples; local empty becoming nonempty; global/local mixtures; timezone revision;
historical/left members; old writers; parent edits; impact status changes; exact
start/end/horizon equality; future starts; late stale fills; malformed/oversized
payloads; transaction retries; unchanged final fence and settlement.

Baseline: four SELECTs per fingerprint. Design target with folded witnesses:
three warm planning plus four final-fence SELECTs = seven versus eight baseline.
Cold target is five plus four = nine. These are estimates. A separate witness
read increases the budget. Count actual full-attempt queries, trigger writes,
Redis calls, retries, jobs, buffers and elapsed time in global/local/no-local and
post-event cases. CPU claims require actual CPU measurement.

Require net work reduction for repeated planning and exact outcome parity.
Do not claim zero DB work: witnesses/final checks remain. Document cold-cache
and mutation overhead. Run relevant integration suites and backend checks,
preserve existing assertions and disclose baseline failures. Frontend analysis
must pass. Production deployment/measurement requires separate authorization.

## Revision log

- Initial gap passes added outage/concurrency and compatibility cases.
- Architect and analyst rejected timestamp-only completion: it could omit history,
  late samples and upcoming boundaries.
- Replaced completion tracking with exact vectors and row-local witnesses.
- Removed accepted-user filter absent from canonical SQL.
- Retained raw transaction/settlement reads and rejected new release flags under
  the user-provided AGENTS prohibition.
- Corrected monitoring interval and production display-trigger claims.
