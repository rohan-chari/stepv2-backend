# Races-tab open capacity requirements

## Summary and user story

Add a `races-tab-open` workload to the existing `./perf` harness so an operator
can measure how many authenticated users per second can reveal and refresh the Races tab on
the production-sized capacity VM. One iteration represents one real navigation
to the Races tab, not a weighted bag of unrelated Races endpoints.

The first use is a warm-cache baseline and capacity ladder. Home has already
populated the client-side race list in this normal entry state, so the tab is
usable immediately while its core data refreshes. The result measures that
refresh, background health, and PostgreSQL, Node, Redis, DB-pool, event-loop,
and queue resources. It must not label refresh latency as visibility latency.

## Source-of-truth client behavior

The current mobile client defines the workload:

1. A Races-tab reveal calls `_refreshRacesTab()` from the page-change handler.
2. Overlapping refreshes in one client are coalesced.
3. Existing race data remains rendered while the client awaits
   `_fetchRacesCore()`, including any device-local pending
   result acknowledgement replay, followed by
   `GET /races?view=compact-v1`.
4. Once the core request completes, it starts
   `GET /races/discovery-summary` without awaiting it.
5. It conditionally refreshes shared friends data when the loaded list is empty
   or its client timestamp is older than 60 seconds. The repository may reuse
   an identical friends read for one second, so the ordinary baseline fixes the
   reveal between one and 60 seconds after Home: a zero-friends user therefore
   performs the request, while a non-empty fresh list does not.

The baseline cohort has no pending device-local acknowledgements. A future
explicit `pending-acks` variant may cover that behavior; it must not be mixed
silently into the baseline.

## Scope

- Add workload selection to `./perf smoke` and `./perf scan`, with
  `home-open` remaining the backward-compatible default.
- Add an authenticated `races-tab-open` k6 session and fixture profile.
- Reuse the existing prepared Lima environment, disposable marked database,
  two HTTP workers, one resolution worker at concurrency two, cron companion,
  Redis, metrics collection, scan state machine, runtime accounting, and
  report locations.
- Generate one core request and one background discovery request per tab open.
- Model the conditional `GET /friends?view=summary-v1` branch from fixture
  client state. The ordinary baseline represents a typical Races reveal more
  than one second and within 60
  seconds of Home loading: users with a non-empty loaded list do not refetch;
  users with zero friends do, matching the current `_friendsSteps.isEmpty`
  condition. The zero-friends share comes from the versioned production-shaped
  fixture distribution, not an invented probability.
- Replace the limited first profile with a full-page `2.0.0` fixture profile.
  Preserve the measured Home-derived active-race and zero-friends marginals,
  then materialize and interleave every API-backed state the Races tab renders:
  active, pending, completed, race invites, tournaments in each personal-list
  state, team races, pinned rows, placements/privacy, inventory, active effects,
  and discovery's public-race count.
- Embed each fixture user's expected response-content shape in the k6 fixture.
  Validate and aggregate the actual payload content during load so a fast empty
  response cannot pass as representative page capacity.
- Gate successful core-refresh completion on the core request. Track discovery and conditional
  friends completion/error/latency separately and fail a rate if background
  requests are dropped, incomplete, or exceed their configured error gate.
- Report endpoint request counts so the generated fan-out is auditable.
- Preserve the scan rules already approved: short discovery levels, first
  failure confirmation, boundary narrowing, explicitly measured safe-rate
  candidate, and one-time environment preparation/prewarm.

## Non-goals

- Race-detail opens, messages, progress polling, powerup activity, race joins,
  race creation, pull-to-refresh bursts, and Home traffic.
- Treating every user as having a stale friends cache. That becomes a separately
  named `stale-friends` scenario if it is needed after the ordinary baseline.
- A cold/empty-client Races screen, which must be a separately named scenario.
- Production traffic or production database writes.
- Recreating PostgreSQL, Redis, backend processes, or fixtures per level.
- Changing any application endpoint or mobile behavior.
- Certification-grade endurance evidence in the initial smoke/scan.
- Review-prompt and payout-double flows that do not render on the Races tab.
  The endpoint may carry additive compatibility fields for other consumers,
  but this workload neither invents nor gates on off-screen product flows.

## Operator contract and configuration

Commands:

```text
./perf smoke --workload=races-tab-open
./perf scan --workload=races-tab-open
./perf scan --workload=races-tab-open --rates=5,10,15,20,25,30
```

`performance/config/default.json` gains centrally configured workload entries.
The selected workload is recorded in the immutable manifest, `summary.json`,
and `report.md`. Changing it invalidates prepared workload fixtures but must not
weaken environment ownership or production-isolation checks.

Initial thresholds mirror the established interactive screen contract unless
measured production behavior justifies a versioned change:

- core Races-tab p95 <= 1000 ms;
- core Races-tab p99 <= 2000 ms;
- HTTP error rate < 0.1% (exactly 0.1% fails, matching the evaluator);
- zero network errors, incomplete core transactions, or dropped arrivals;
- zero incomplete required background discovery requests;
- zero incomplete selected background friends requests;
- zero worker restarts or DB connection exhaustion;
- existing numeric queue/resource safety gates once available.

Warmup, measurement duration, runtime budget, headroom policy, failure
confirmation, and narrowing remain shared central scan settings. The workload
must not introduce per-level setup or full-cache prewarming.

The full-page profile is `authenticated-races-tab-reveal-v1@2.0.0`. Profile
`1.0.0` results remain readable historical evidence but are not comparable to
the expanded fixture topology.

### Central full-page profile limits

The following values are part of profile `2.0.0`, live in central performance
configuration, and are copied into the manifest and result:

- `minimumMeasuredSessions: 300`;
- `maximumCoverageAugmentationShare: 0.10`;
- `iterationDeadlineSeconds: 31` and `identitySafetyFactor: 1.05`;
- separate stabilization-warmup and measurement identity pools;
- `maximumFixtureIdentities: 5000` and `maximumFixtureBytes: 67108864`;
- generator CPU gate `< 85%`, zero generator dropped arrivals, and generator
  scheduler-lag p99 `<= 1000 ms`.

For every attempt, including confirmation, deciding, narrowing, and safe-rate
attempts, `measurementSeconds = max(configuredMeasurementSeconds,
ceil(minimumMeasuredSessions / rate))`. Runtime estimates and reconciliation
use that effective duration, so a candidate below 5/sec runs longer instead of
being rejected or reported without measurement. Required identities are
`2 * ceil(rate * iterationDeadlineSeconds * identitySafetyFactor)`: one pool
for level stabilization and one disjoint pool for measurement. With 5,000
identities the profile's maximum permitted configured rate is therefore
`floor(5000 / (2 * 31 * 1.05)) = 76` opens/sec. The harness may allocate more
k6 VUs than the rate requires, but `preAllocatedVUs` must be at least
`ceil(rate * 31 * 1.05)`, `maxVUs` must equal that bounded value, and neither
pool may reuse an identity concurrently. These workload-specific limits take
precedence over a larger generic CLI rate ceiling.

## Session contract

Each virtual user is assigned one fixture identity per iteration and sends the
same production client identity/capability headers used by the current app.

1. Start `races_tab_sessions_started`; fixture state represents Home having
   already populated client-side races and friends.
2. Send `GET /races?view=compact-v1`.
3. Require HTTP 200, `contract == "race-list-compact-v1"`, and valid `active`,
   `pending`, `completed`, and `tournaments` lists. Compare the response with
   the selected fixture identity's expected content shape: bucket counts,
   invites, favorites/pins, team rows, tournament states, placement states,
   inventory/queued-box rows, and active-effect rows. A structurally valid but
   unexpectedly empty or incomplete response is a contract failure.
4. Record `races_tab_core_refresh_ms`; only then record
   `races_tab_sessions_core_refresh_complete`.
5. Send `GET /races/discovery-summary` and validate the current supported
   response contract even when core failed, matching the client's caught-error
   flow. Discovery and the selected friends request start concurrently. A 404
   is a contract failure for this current-backend profile rather than silently
   changing to the legacy four-request fan-out. A 200 records every branch's
   `resolved` state; an unresolved branch is incomplete background work. Every
   generated request must finish within the bounded iteration deadline.
6. If the fixture identity has zero friends, send
   `GET /friends?view=summary-v1` in parallel with discovery, matching the
   ordinary fresh-client-cache branch described above.
7. Record per-endpoint latency, status, completion, and response bytes.
8. Record response-content counters and distributions for ordinary races,
   tournaments, invitations, favorites, teams, placements, inventories,
   effects, and public-race count. Counts must reconcile with fixture
   expectations for every measured session.

### Versioned expected projection and field/state matrix

Each fixture record contains `expectedProjectionVersion:
"races-tab-open-projection-v2"` and a normalized expected projection. It uses
sorted synthetic fixture indexes rather than user/race UUIDs in evidence and
contains:

- `ordinary.active[]`, `ordinary.pending[]`, `ordinary.completed[]`, and
  `ordinary.invited[]`: row key, name, status, creator display value,
  `isCreator`, participant count, caller `myStatus`, `maxDurationDays`,
  classic/team kind, favorite state/order, raw placement value/hidden state,
  `myDisplayPlacement`, `placementPrivacyActive`, and the time/status fields
  used to bucket and render the row;
- team rows: team size, caller team, both team names, both persisted totals,
  totals `asOf`, and winner team where applicable;
- `ordinaryInventoryByRace[]`: held typed items, unopened mystery boxes,
  queued-box count, and item status/type/rarity; and
  `ordinaryEffectsByRace[]`: active positive and negative effect type/count;
- `tournaments.invited[]`, `tournaments.pending[]`,
  `tournaments.active[]`, and `tournaments.completed[]`: row key, name, caller
  participant status, favorite state/order, bracket size, accepted count,
  current/total round, prize values, caller identity
  display/animal/accessory projection, and one explicit render state from
  `invite`, `lobby`, `between_rounds`, `live_match`, `eliminated`, `champion`,
  or `completed_non_champion`;
  these rows use the app's action-first shelves: `live_match` is active;
  `lobby` and `between_rounds` are pending; and `eliminated`, `champion`, and
  `completed_non_champion` are completed;
  the normalized row also records the identifier-free
  `hasCurrentMatchRaceId` signal used by the real client to select live-match
  actions. Fixture accessories are real owned/equipped database rows and are
  validated through `GET /races`, not projected from invented fixture JSON;
- `tournamentMatchByTournament[]`: current matchup race key, caller
  placement/hidden state, ends-at, round label, per-match inventory, and queued
  boxes. Opponent details and matchup effects are not in this endpoint contract.
  Tournament-match placement and inventory are never merged with ordinary-race
  placement and inventory;
- `discovery.publicRaceCount` and `friends.shouldRequest`, expected count, and
  expected summary contract.

The required coverage variants are: ordinary classic active, ordinary team
active, ordinary pending owner, ordinary pending accepted, ordinary invite,
ordinary completed, pinned classic, pinned team, pinned tournament, visible
ordinary placement, hidden ordinary placement, ordinary held typed item,
ordinary mystery box, ordinary queued box, ordinary positive effect, ordinary
negative effect, tournament invite, tournament lobby, tournament
between-rounds, tournament live match, tournament eliminated, tournament
champion, tournament completed non-champion, visible tournament-match
placement, hidden tournament-match placement, tournament-match held typed item,
tournament-match mystery box, and tournament-match queued box. There are 28
variants. All API fields that drive these projections have exact type
and nullability assertions; extra additive API fields remain allowed.
Placement coverage follows the real privacy projection: a privacy-active row
with a valid `myDisplayPlacement` is visible, while hidden means either the
explicit hidden flag or privacy-active with no display placement. Node capture
and k6 use the same predicate for ordinary and tournament-match rows.

`CANCELLED` is an app render branch but is not a 29th measured variant: the
current `GET /races` tournament query explicitly excludes cancelled rows. The
fixture, summary, and report therefore mark it API-unavailable/excluded and do
not claim measured API-backed coverage for it. Adding cancelled rows to the
fixture would not exercise that branch without an application API change,
which is outside this workload.

Every discovery, confirmation, deciding, narrowing, and safe-candidate attempt
must compare every response to this projection. Exact bucket row keys and
semantic values must agree; aggregate totals alone are insufficient. A mismatch
is both a contract failure and a failed attempt.
Coverage counters are derived independently from predicates over each observed
normalized response. Assigned fixture labels are validated against the initial
HTTP capture, but k6 never increments coverage from those labels.

The k6 arrival rate means complete Races-tab reveals started per second. It is
not endpoint RPS. With default fan-out, `10/sec` means approximately ten core
requests and ten discovery requests per second.
The additional friends RPS equals the measured zero-friends cohort share times
the tab-open rate.

Each endpoint uses the mobile client's 15-second timeout. The overall iteration
deadline is 31 seconds: one core timeout window, one parallel background timeout
window, and one second of scheduler allowance. Graceful stop is 32 seconds.
VU allocation is derived from rate times this deadline with bounded overhead.
Every attempt must offer and start exactly `rate * effectiveMeasurementSeconds`
sessions,
record scheduler lag and quota drift, prevent concurrent reuse of one fixture
identity, and reconcile every request plus the background tail.

## Fixtures, cache, and reset

Reuse authenticated synthetic/sanitized capacity users. Profile 2.0 combines
the existing production-derived active-race and zero-friends marginals with a
production-derived joint census for Races-tab-visible states. The identifier-
free source census records user counts and joint combinations for:

- ordinary active, pending, completed, and invited race membership;
- active/pending/completed/invited tournament membership;
- classic versus team races and team size;
- favorite/pinned ordinary races and tournaments;
- visible, hidden, and privacy-projected placement;
- non-empty held/mystery/queued inventory;
- non-empty ordinary-race active positive/negative effects;
- public-race count returned by discovery.

The generator deterministically apportions the complete mutually exclusive
source user profiles so each generated identity inherits exactly one source
profile before any coverage-floor additions. It scales complete ordinary-race,
tournament-parent, and live-match graph shapes first, then assigns those
identities to the graph capacity; natural ordinary and matchup
inventory/effect marginals and joint combinations must stay inside source
support. Generated shapes outside that support are permitted only when
explicitly labeled coverage-floor augmentation. The
central 300-session/28-variant coverage floor guarantees that every visible
family appears in every measured attempt even when its source incidence is
rare; the report separates naturally scaled rows from coverage-floor
augmentation.
No category may be silently invented, omitted, or presented as a production
percentage. Lock platform/capability mix, source timestamps, source hashes,
scaling policy, and coverage-floor version in fixture evidence.

The identifier-free census is generated only from the already-isolated,
sanitized capacity database, or consumed as a checked-in identifier-free
artifact. `./perf` never connects to production to acquire or refresh it. It
records joint histograms for rows per personal bucket, accepted participants
per ordinary race, fixture users sharing a race, tournament bracket size,
tournament total-participant and accepted-participant counts, live-match
participant count, ordinary and matchup inventory counts, effect
counts, core response bytes, and their correlations. The deterministic scaler
preserves shared membership by scaling concrete race graphs and their frequency
targets first, then assigning heterogeneous user profiles to participant,
inventory-owner, and effect-target slots. Evidence reconciles the materialized
graph frequencies and every generated user's inventory/effect ownership against
those assignments; it does not create one private race per user merely to match
marginal counts. Source, naturally generated, and augmented histograms and p50/p95
response bytes are reported separately for each core fixture family.
Generated-response capture is keyed by independently observed projection
variant, total core row count, and natural-versus-coverage-floor provenance;
fixture-assigned labels are not accepted as response-size evidence. Per-user
assignment arrays remain only in the bounded credential fixture and are not
duplicated into `fixtureProfile` or per-level evidence.

Every normal measured attempt has at least 300 sessions. In the deterministic
ordered 300-session prefix, every one of the 28 required variants must occur at
least once. The same rule is independently enforced for repeated boundary,
narrowing, and safe-candidate attempts. Natural generated rows count first;
only missing variants are added, with deterministic lowest-index placement.
Augmentation may affect at most 10% of identities in the prefix. A variant with
zero source incidence is labeled `synthetic_coverage_only` and is excluded from
claims about production incidence. Preparation fails rather than weakening any
of these bounds.

### Exact fixture graph and pinned settings

The manifest owns every generated primary key. An ordinary row consists of one
`Race`, its creator and accepted/invited `RaceParticipant` rows, and, where the
projection requires them, caller `favoritedAt`, participant totals/team,
`RacePowerup`, and `RaceActiveEffect` rows. Active effects reference a real
fixture powerup and target participant. An ordinary invite has an INVITED
caller participant and a distinct creator with a display name.

A tournament row consists of one `Tournament`, the source-scaled total number
of `TournamentParticipant` rows, the source-scaled accepted subset (never above
`bracketSize`), and the real matchup `Race` rows required through the declared
current round. Accepted started-bracket participants have unique seeds; lobby
fixtures preserve total/accepted counts instead of filling every bracket. Each
matchup has matching
`tournamentId`, one-based `tournamentRound`, zero-based
`tournamentMatchIndex`, and exactly two accepted `RaceParticipant` rows.
Elimination/champion fields, participant statuses, current round, matchup
status/timestamps, and completion timestamps must jointly encode the declared
render state. Match inventory attaches to the matchup race, never the tournament
parent. Prize snapshot/funded fields encode the projected
prize without reading a mutable live setting.

In the disposable database, preparation pins through the existing app-settings
write path (including its Redis/pub-sub worker-cache invalidation)
`apiRaceListCompactV1Enabled=true`, `redisCacheRaceListEnabled=true`, and
`raceListSqlSummaryV1Enabled=true`, records their prior values, and restores
those values through the same invalidating path during cleanup. Before prewarm,
a worker-distinguishing readiness probe must prove that both HTTP workers
observe all three intended values. All start/end/invite/effect-expiry timestamps have
a guard band longer than the maximum workflow runtime; no fixture is eligible
for auto-start, expiry, resolution, seeding, or settlement. Pre/post checks
verify every predicate-driving status/timestamp/favorite/placement/inventory/
effect/team/tournament field and the exact discovery public count.

Users are ordered with deterministic multi-dimensional stratification so each
rate prefix preserves the source marginals while exercising all visible
families. Fixture timestamps stay away from start/end/invite-expiry boundaries
for the maximum scan duration. Verify all modeled rows and their relevant
mutable fields before and after the scan so cron cannot silently change later
levels. Cleanup owns every added row by exact fixture IDs.

The workload is read-only for the baseline. Its reset plan must prove that no
endpoint in the baseline mutates durable user/race state. If source inspection
or integration evidence finds a write, add only its run-owned selectors to the
existing targeted reset; do not add per-level database restoration.

This is a steady-state warm refresh, not a claim that every request is a cache
hit. Initial prewarm runs the deterministic core-only conditioning schedule for
the measurement pool; it does not warm discovery or friends. Per-level warmup
uses only the separate stabilization pool and does not touch upcoming measured
identities. It never clears Redis or rebuilds data. The report records observed logical
race-list reads rather than cache-fragment writes: Redis hits are collapsed to
one read and the compact bounded query is recorded as a PostgreSQL `bounded`
read. Validated capacity mode records every bounded read; ordinary production
samples successful bounded-read telemetry at the existing 1-in-100 cadence to
avoid adding material log pressure to the hot path. Those sources/outcomes are
compared against a centrally configured,
versioned target mix calibrated from identifier-free
production telemetry. Until that calibration exists, smoke and diagnostic
scans may run but safe capacity is unavailable. Cold cache is separate.

Cache construction is deterministic. The measurement pool is partitioned by
the configured versioned conditioning profile into core-fragment
`hot-15s`, `hot-30s`, and `expired-300s` cohorts. Before every measured attempt,
the harness deletes only that attempt's exact run-owned measurement identity
cache keys and calls only the core route at scheduled offsets needed to
establish those ages; it never calls discovery or friends. This bounded
schedule has one wall-clock deadline, including Redis deletion, HTTP requests,
and sleeps. The remaining deadline and one shared abort signal are passed into
the asynchronous Redis deletion, HTTP requests, and deadline-aware sleeps; on
expiry the work is cancelled and every started operation settles before the
workflow advances. Each attempt records actual duration, configured budget, and an
explicit overrun state; an overrun fails the harness rather than silently
extending level ceremony. Concurrent conditioning requests use settled cleanup
semantics: after any rejection or timeout, every already-started request must
settle before the workflow can clean up or advance. This bounded
per-attempt cache conditioning is not environment setup, Redis recreation, or a
namespace flush. Per-level stabilization traffic runs first using its separate
identity pool and never changes the upcoming measurement identities. Only after
stabilization finishes does the harness condition the measurement pool, so the
15/30-second cohorts retain their intended ages. After conditioning
finishes and immediately before measured traffic, the harness resets the
metrics epoch and records worker-log byte offsets. Cache evidence accepts only events carrying
the current run ID, measurement attempt ID, phase `measurement`, and timestamps
after that offset/epoch. Startup conditioning, warmup, prior attempts, and
unrelated worker events cannot contribute to an attempt's cache mix.
The checked-in first-run partition is labeled
`diagnostic-balanced-uncalibrated`, not production-shaped. It permits smoke and
diagnostic scans while `raceListTargetMix` remains `calibration-required`; it
cannot produce safe capacity. Replacing it with a production-calibrated
version requires identifier-free calibration evidence and an explicit profile
version change.

Cleanup deletes the run manifest's rows in dependency order: active effects,
race powerups, matchup and ordinary race participants, friendships, tournament
participants/favorites, matchup races, ordinary races, tournament children,
tournaments, then synthetic users and restored app-setting values. It removes
only exact run-owned Redis race-list fragment/meta/version keys and no wildcard
namespace. Automated tests inject failures after each preparation phase and
prove cleanup after partial preparation, success, workload failure, timeout,
and SIGINT/SIGTERM interruption; baseline row counts and owned-key absence must
match after each path.

## Result contract and report

The existing versioned summary receives workload-neutral screen fields plus a
`racesTabOpen` section containing:

- started and core-refresh-complete sessions;
- core p50/p95/p99 latency and response bytes;
- discovery started/completed/error counts and p95/p99 latency from the
  endpoint-tagged measurement-phase HTTP duration metric;
- conditional friends started/completed/error counts and p95/p99 latency from
  the endpoint-tagged measurement-phase HTTP duration metric;
- the fixture zero-friends share that selected the branch;
- the fixed fresh-client cache age (>1 second and <60 seconds) that makes the
  zero-friends branch observable rather than hidden by one-second read reuse;
- request counts by endpoint;
- observed endpoint RPS, scheduler lag/quota drift, and race-list cache-source
  mix versus its configured target;
- incomplete background work and iteration-deadline timeouts;
- per-attempt content totals, coverage status, and bounded mismatch counts;
- payload-content evidence for ordinary buckets, invites, tournaments by state,
  pinned classic/team/tournament rows, team sizes, placement states, inventory,
  queued boxes, active effects, and discovery public-race counts;
- expected-versus-observed content mismatch count, which must be zero.

Workflow-wide `fixtureProfile` evidence appears once at the top level: source
artifact hash/version, source/natural/augmented joint distributions, response
size distributions, preparation duration/row-count warnings, coverage policy,
cohort bounds, pinned settings, and pre/post stability/cleanup evidence. Each
`levels[].racesTabOpen` contains only that attempt's request/content totals,
variant coverage, cache epoch/mix, and mismatch enum counts. Stable mismatch
enums identify bucket, ordinary field, team field, ordinary inventory/effect,
  tournament state/identity/prize, matchup placement/inventory, discovery
count, friends, or unknown mismatch. No user/race ID is used as a metric tag.
A separate `races-tab-mismatches.json` contains at most 50 samples using
synthetic fixture indexes and redacted expected/observed details; truncation is
explicit. Exact endpoint, branch, public-count, and projection reconciliation
is required for every attempt purpose.
Mismatch fixture indexes are relative to the current measurement pool
(`userIndex - userOffset`), so the capped first-50 policy applies correctly to
nonzero measurement offsets and never silently samples the stabilization pool.

The additive summary schema becomes `bara-perf-summary-v3`. Existing Home fields
remain unchanged. Each `levels[]` row gains `racesTabOpen`. Workload-neutral
capacity fields are `highestPassingRate`, `firstFailingRate`,
`calculatedHeadroomTarget`, `safeCapacityCandidateTested`,
`safeOperatingRate`, and `safeOperatingRateUnit` (here,
`races_tab_opens_per_second`). `safeHomeOpensPerSecond` remains Home-only.

Stable Races failure reasons include `races_core_p95_threshold`,
`races_core_p99_threshold`, `incomplete_races_core_transactions`,
`incomplete_races_discovery`, `incomplete_races_friends`,
`races_contract_error`, `scheduler_quota_drift`, and
`cache_profile_mismatch`, alongside shared network/resource/worker reasons.
They remain separate from primary bottleneck.
The full-page profile also adds `races_payload_content_mismatch` and
`fixture_state_coverage_missing`; either prevents a passing rate.

Each rate retains PostgreSQL CPU, Node CPU, Redis CPU, DB-pool wait, event-loop
delay, queue growth, top SQL, failure reason, and primary bottleneck. Failure
reason remains separate from bottleneck.

The human report leads with `Races tab opens/sec`, core-refresh p95/p99, background
health, and resource use. It must explicitly explain that tab-open rate is not
total HTTP RPS.

## API contract, data model, and compatibility

No application API, response shape, schema, or migration changes are allowed.
The harness consumes the existing authenticated endpoints. Older mobile clients
are unaffected because no production application behavior changes. The
workload defaults to the currently deployed request/header contract and stores
its own profile version, so future app behavior requires an explicit workload
version update rather than silently changing historical comparisons.

## Tests-first implementation plan

1. Add failing CLI/config tests for `--workload=races-tab-open`, rejection of
   unknown workloads, backward-compatible Home defaulting, and manifest
   binding.
2. Add failing session-contract tests proving one successful iteration makes
   exactly one core request followed by discovery, measures core refresh completion
   before background completion, and selects the friends branch from fixture
   state rather than randomness.
3. Add failing malformed/error/timeout tests for each response, core failure
   followed by background launch, discovery/friends parallelism, partial
   discovery resolution, and supported-profile 404 rejection; ensure no false
   completed transaction is recorded.
4. Add failing fixture tests for the production-derived joint census,
   deterministic scaling/interleaving, every visible state family, explicit
   300-session/28-variant coverage-floor accounting and 10% augmentation bound,
   shared-race/cardinality preservation, valid auth, response materiality,
   pinned settings, pre/post field stability, exact graph/Redis cleanup
   ownership, and cleanup under partial/success/failure/timeout/interruption.
5. Add failing evaluator/report tests for Races-specific metrics, endpoint
   counts, cache mix, scheduler accounting, background incompleteness, stable
   Races failure reasons, bottleneck, workload-neutral rate fields, Home legacy
   compatibility, and explicit tested-safe-rate semantics.
6. Add failing real-HTTP integration coverage proving fixture identities receive
   expected active/pending/completed/invite/tournament/team/pinned/placement/
   inventory/effect payloads, ordinary name/owner state, tournament name/
   accepted count, and the expected public count through the same endpoints and
   headers used by k6.
7. Add failing workload tests for the exact normalized v2 projection, separate
   ordinary/matchup inventory and placement, all seven tournament render states,
   per-attempt metric/log epochs, bounded diagnostics, identity/VU/rate bounds,
   generator gates, and fixture-file size rejection.
8. Implement workload selection, fixtures, k6 session, normalized evidence,
   and reporting in that order.
9. Run backend unit tests, then only integration tests whose `DATABASE_URL` is
   confirmed to name the dedicated `_test` database.
10. Do not run smoke or scan during this implementation request. Leave both
   operator commands documented and executable after automated verification.

## Implementation files

- `performance/lib/cli.js`, `performance/lib/config.js`, and
  `performance/lib/main.js`: select and bind the workload.
- `performance/config/default.json`: central Races workload and thresholds.
- `performance/workloads/races-tab-open.js`: fixtures, execution, evidence.
- `scripts/k6/races-tab-open.js`: client-faithful k6 session.
- `src/modules/loadTesting/contract.js` and a focused fixture module: versioned
  endpoint/header and cohort contract.
- `performance/lib/evaluate.js`, `performance/lib/report.js`, and result schema
  tests: workload-neutral screen evaluation plus Races details.
- `test/lib/perf/`, `test/modules/loadTesting/`, and a real HTTP integration
  test: tests listed above.

## Acceptance criteria and definition of done

- One iteration faithfully represents one ordinary Races-tab reveal.
- `10/sec` unambiguously means ten tab reveals started per second.
- Core refresh completion and background completion are distinct metrics.
- Generated endpoint counts reconcile with iteration counts and fixture branch
  membership.
- Every API-backed data family rendered by the Races tab is materialized,
  exercised in normal measured prefixes, validated against per-user
  expectations, and summarized in machine/human output.
- The normalized v2 projection distinguishes ordinary and tournament-match
  inventory/placement and covers all 28 required variants, including every
  tournament render state, team semantic, identity/accessory/prize field, and
  positive/negative effect branch.
- Ordinary rows validate `myStatus`, `maxDurationDays`,
  `placementPrivacyActive`, and `myDisplayPlacement`; tournament rows use the
  app's action-first shelves. CANCELLED remains explicitly excluded because it
  is not returned by the current endpoint.
- The identifier-free source census and generated fixture preserve the locked
  row, participant, shared-membership, bracket, inventory/effect, and response-
  byte joint distributions; source-zero variants are clearly coverage-only.
- Every attempt contains at least 300 sessions, covers all required variants,
  and changes at most 10% of prefix identities through deterministic coverage
  augmentation.
- Discovery and conditional-friends p95/p99 values come from endpoint-tagged,
  measurement-phase HTTP metrics and are finite when those requests run.
- Race-list cache evidence counts logical reads (including compact bounded
  PostgreSQL reads), not per-fragment cache events or writes.
- Capacity mode captures every compact bounded read while ordinary production
  telemetry is deterministically sampled at 1 in 100.
- Fixture evidence separates production-derived incidence from explicit
  coverage-floor augmentation and proves every visible state family.
- Scan records app, DB, Redis, pool, event-loop, queue, and SQL evidence for
  every measured level.
- The existing failure-confirmation and tested-safe-capacity algorithms apply
  unchanged.
- Preparation/prewarm happen once; no per-level environment, DB, Redis,
  backend, or fixture recreation is introduced.
- Bounded core-only per-attempt conditioning of exact run-owned keys establishes
  deterministic hot/expired cache cohorts; stabilization and measurement
  identities are disjoint, and attempt epochs prevent conditioning, warmup, or
  earlier-level cache evidence contamination.
- The 31-second deadline, VU formula, 5,000-identity/two-pool bound, 76/sec
  profile ceiling, 64 MiB fixture limit, and generator health gates fail fast
  when violated rather than being misclassified as backend capacity.
- Workflow-wide fixture evidence is emitted once, attempt evidence is bounded,
  diagnostic samples are capped at 50, and identifiers never become metric
  tags.
- Every production target/write guard remains intact and tests prove it.
- Exact graph and Redis-key cleanup is proven after partial preparation,
  success, failure, timeout, and interruption, with pinned app settings restored.
- Safe capacity remains unavailable without required resource baselines,
  fixture stability, and cache-profile evidence.
- Relevant unit and `_test` integration suites pass. Smoke and ladder are not
  run as part of this setup-only request.
- No frontend behavior or client-visible backend behavior, API, or schema
  changes; the only backend addition is identifier-free source telemetry for
  the existing compact bounded race-list read.

## Revision log

- Gap pass 1: separated core refresh completion from non-blocking discovery,
  excluded device-local acknowledgement replay from the ordinary baseline,
  and made endpoint-count reconciliation explicit.
- Gap pass 2: modeled the conditional friends request from fresh client state
  and the production-shaped zero-friends cohort, bounded background completion
  within each iteration, and made workload versioning and prepared-fixture
  invalidation explicit.
- Architect review: corrected warm-tab semantics from visibility to refresh,
  locked compact response/fallback behavior, bounded request and iteration
  deadlines, added scheduler/request reconciliation, expanded fixture/cache
  evidence, and separated Races result fields from legacy Home fields.
- Full-page expansion: replaced the limited active/zero-race profile with a
  versioned complete Races-tab fixture census, per-user payload reconciliation,
  content-distribution reporting, and an explicit no-smoke/no-ladder handoff.
- Frontend parity pass: added the ordinary duration/status and privacy-display
  inputs, aligned tournament buckets to action-first UI shelving, and recorded
  CANCELLED as excluded/non-required because the existing query omits it.
