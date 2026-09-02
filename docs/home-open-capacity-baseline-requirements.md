# Home-open capacity baseline requirements

## Summary and user story

Build a capacity-only `home-open` k6 profile that answers one operator question:

> How many authenticated users can open Home per second on the current
> production-shaped hardware while every required Home request completes and
> the screen remains within its latency and reliability objectives?

The unit under test is one coherent Home-open session, not one randomly chosen
Home-related HTTP request. The harness must preserve the Flutter client's
request dependencies and parallelism, report offered and successfully completed
sessions separately, and run only against the guarded disposable capacity VM.

This is non-production test infrastructure. It changes no public API, app UI,
database schema, game behavior, or production runtime configuration.

## Current behavior and implementation anchors

- `lib/screens/main_shell.dart` in the frontend owns the real Home load. It
  persists steps first, then starts suggested races beside the modal-critical
  Home work, runs race card and personal races concurrently, waits for race
  card, and conditionally adds presentation/friends fallbacks before declaring
  the required Home surfaces settled.
- `src/modules/loadTesting/contract.js` already defines a `home` profile, but
  that profile independently samples weighted endpoint entries. Its arrival
  rate is requests/second, not completed Home sessions/second.
- `src/modules/loadTesting/runner.js` already provides a coherent session
  primitive for `event-open-surge`, including open-loop pacing, offered versus
  completed accounting, and parallel requests after authentication.
- `scripts/k6/event-open-surge.js` and `scripts/k6-event-open.js` provide the
  genuine-k6 orchestration pattern and guarded capacity binding to reuse.
- `scripts/capacity.js`, `scripts/lima-capacity.js`, and
  `docs/capacity-lima.manifest.json` guard the disposable Lima lifecycle and
  production-shaped resource declaration.

## Scope

### Included

1. Add a permanent, capacity-only `home-open` load profile.
2. Represent one Home-open as a coherent authenticated session with a unique
   synthetic user context and session-level latency.
3. Reproduce the current shipped client's authenticated foreground/resume Home
   request order, parallelism, retries, response-dependent fallbacks, and
   non-gating background work.
4. Execute an open-loop ladder in complete Home sessions per second.
5. Capture session and endpoint latency, completion, HTTP errors, timeouts,
   application resources, database resources/pool waits, Redis, queue lag, and
   process census.
6. Stop escalation at the first failed level, then bracket the boundary with
   repeat runs.
7. Produce immutable artifacts from which a safe operating ceiling and an
   estimated users-per-timeframe range can be calculated.

### Non-goals

- No production traffic or production database writes.
- No production or staging deployment.
- No fresh production snapshot unless separately authorized in the moment.
- No race-detail viewing, race polling, chat, powerup, shop-browsing, profile,
  onboarding, or event-boundary workload in this profile.
- No frontend behavior or API response change.
- No pull-to-refresh workload and no frozen-client workload in the primary
  baseline. Those are separate future sensitivity profiles because their
  request graphs differ from a current-client foreground/resume Home open.
- No attempt to make the local CPU architecture, Node version, or PostgreSQL
  major version identical; the user explicitly accepted those differences for
  this baseline.
- No claim that Home-only capacity equals combined whole-app capacity or DAU.

## Capacity environment

Before every ladder, the guarded start command must print and validate:

- backend allocation: 4 vCPU, 8 GiB RAM, 160 GiB disk;
- two HTTP workers with database pools of 10 each;
- one resolution process with a database pool of 8;
- one cron process with a database pool of 4;
- disposable PostgreSQL allocation: 1 vCPU, 2 GiB RAM, 30 GiB disk, 47 maximum
  connections;
- Redis 7.0.15 with 100 MiB data max, `allkeys-lru`, and persistence disabled;
- loopback-only API/database/Redis connectivity and outbound providers disabled.

The containing Lima VM may allocate the sum of the separately constrained
backend and database resources. For this baseline it must allocate 7 vCPU and
12 GiB RAM: the backend remains cgroup-capped at 4 vCPU/8 GiB, PostgreSQL at
1 vCPU/2 GiB, Redis at 1 vCPU/256 MiB, and the remaining 1 vCPU/~1.75 GiB is
reserved for the guest OS, container runtime, and monitoring. The generator
runs on the host outside this envelope. Results must print and stamp both the
containing allocation and every constrained component allocation, plus the
manifest hash, backend commit, profile version, run ID, and scrub-attestation
hash. The result measures the declared component caps; it must not describe the
extra containing-VM overhead reservation as production application capacity.

## Home-open session contract

### Fixture preconditions

Each session uses one of the run's synthetic authenticated users and the exact
current-client headers, including current `X-App-Version`, the full platform-
appropriate `X-Client-Features`, timezone, release channel, and platform.
Tokens, idempotency keys, device/source identifiers, and writes are run-bound
and synthetic.

Before smoke, fixture creation must write an aggregate topology manifest that
contains no identifiers and is stamped into every result: synthetic user count,
users by active-race count, races by participant-count band, maximum race size,
shared-race concentration, step-sample count/window, and minimum/median user
reuse interval at the configured rate. The representative topology must be
derived from aggregate distributions in the scrubbed capacity snapshot and
materialized into synthetic fixtures. Every ladder candidate starts from the
same topology manifest and clean fixture state. A later hotspot profile may put
all users in one race, but this representative baseline must not do so.

Fixtures must disable/omit global-event summary work so no unmodeled summary
poller changes the request graph.

### Request sequence

One offered session performs the following logical flow:

1. Use the pre-created synthetic authentication token. Authentication fixture
   setup is outside measured session latency. This is an authenticated
   foreground/resume Home load, not app sign-in and not pull-to-refresh.
2. Persist steps before fetching Home:
   - every primary-baseline session uses `POST /steps/sync-v2` without
     `X-Step-Sync-Intent: home-pull`, with one bounded sample window and a unique
     deterministic idempotency key;
   - on the same ambiguous transport/status classes as the current client,
     retry once with the identical key and body;
   - on a definite route-unsupported or pre-persistence `ASYNC_DISABLED`
     response, follow the current client's legacy fallback: retry `POST /steps`
     once after one second on failure, then send `POST /steps/samples`
     best-effort when samples exist;
   - classify `400`, `409`, `429`, and `503` using the exact client contract;
     none is generic success. In particular, the foreground flow must not gain
     the pull-to-refresh cooldown behavior.
   If persistence ultimately fails, mark the session critical failure but still
   launch the downstream Home reads, matching the shipped client's overload
   behavior instead of shedding load at the capacity cliff.
3. After step persistence settles, start these concurrently:
   - `GET /home/race-card?view=shell-v1&homeActiveRaces=1&localDate=<date>`;
     add `homePersistedTotals=1` only when the successful sync-v2 response says
     the current client may use persisted Home totals;
   - `GET /races?view=compact-v1`;
   - `GET /home/suggested-races` as non-critical background Home content.
4. When race card returns, validate the same `home-shell-v1` resolved blocks
   the Flutter client validates:
   - if presentation is absent, unresolved, or malformed, request
     `GET /shop/catalog`;
   - if friends are absent, unresolved, or malformed, request
     `GET /friends?view=summary-v1` through the shipped friends-summary
     repository path.
5. Request `GET /auth/me?view=shell-v1` concurrently with the post-race-card
   fallback phase for a normal authenticated Home open. This baseline does not
   model the cold-start optimization that can skip one redundant Me refresh.
   A successful Me response triggers an unconditional `GET /assets/manifest`
   using only the shipped `X-Release-Channel` request header and requiring a
   `200` response. Applying a valid race-card presentation also triggers its
   own identical unconditional manifest refresh. A successful
   `GET /shop/catalog` presentation fallback calls the same application path
   and triggers another identical manifest refresh.
6. If sync-v2 returns a race-resolution job receipt, poll
   `GET /steps/race-resolution/:jobId` at the client schedule (750 ms, 1.5 s,
   3 s, and 5 s as cumulative waits), stopping at a terminal response. A
   successful resolution launches race card, compact races, Me, and the
   resulting manifest refreshes again. These calls do not gate the critical
   Home render but do count in all-settled and infrastructure load. Suggested
   races, every triggered manifest, resolution polling, and successful-
   resolution fan-out must settle or reach an explicit bounded deadline before
   `allHomeMs` and `all-settled` complete.

No notification-token registration, version-policy fetch, powerup copy fetch,
Inbox fetch, or race-detail bootstrap belongs to this screen-isolation profile.
Those belong to app-launch or combined profiles. Asset-manifest calls directly
triggered by Home's Me/presentation application are included.

### Session measurements

For every offered session record:

- `criticalHomeMs`: from scheduled session start until step persistence, race
  card, compact races, required presentation/friends fallbacks, and Me refresh
  have settled successfully;
- `allHomeMs`: until suggested races and any resolution polling also settle or
  reach their bounded deadline;
- offered, started, critical-complete, all-settled, and failed counts;
- sync retry/fallback decisions and race-card fallback decisions;
- per-endpoint status, timeout, and p50/p95/p99 latency;
- scheduler lag between intended and actual session launch;
- average and peak in-flight Home sessions;
- generator CPU, generator memory/VU utilization, network errors, k6
  `iterations`, and k6 `dropped_iterations`.

A session is `critical-complete` only when step persistence ultimately succeeds
and all critical requests receive an
allowed, contract-valid response. A scheduled session that cannot start within
its one-second arrival bucket is failed, not silently delayed into a later
bucket. Expected cooldown/idempotency/domain responses must be classified
explicitly; an arbitrary non-5xx response is not automatically success.

Expected offered sessions equal configured arrival rate multiplied by measured
seconds, regardless of whether k6 starts them. Require
`iterations + dropped_iterations == expected`, `dropped_iterations == 0`, and
`critical-complete == expected`. Preserve expected/started/late/dropped counts
for every measured second. Size `preAllocatedVUs` and `maxVUs` from arrival rate
times the bounded all-settled duration so resolution polling cannot manufacture
a VU ceiling.

## Ladder and run lifecycle

### Smoke

Run 1 Home open/second for 2 minutes. Do not begin the ladder unless fixtures,
process census, endpoint coverage, session accounting, metrics sampling, queue
drain, cleanup verification, and all gates pass.

### Initial ladder

Use a newly restored/scrubbed fixture state for every measured level so earlier
writes, caches, steps, and queued work cannot change later candidates. Each run
contains a separately tagged 2-minute warm-up at the lower level followed by a
10-minute measured window; gates exclude warm-up while telemetry covers warm-up,
measurement, and drain continuously.

| Level | Offered Home opens/second |
|---|---:|
| 1 | 2 |
| 2 | 5 |
| 3 | 10 |
| 4 | 20 |
| 5 | 30 |
| 6 | 40 |
| 7 | 60 |
| 8 | 80 |
| 9 | 100 |

Escalate only after the current artifact is complete and its gates pass. Stop
at the first failure. If 100 passes, continue geometrically at 150, 225, 340,
and 500 Home opens/second until failure. The profile hard cap is 500. If the cap
passes, report only `at least 500 Home opens/second`; do not claim a maximum or
calculate a 70% ceiling. Do not overwrite or reuse a failed run ID.

### Boundary confirmation

Choose intermediate rates between the highest passing and lowest failing
levels until the boundary is within 10% or 2 Home opens/second, whichever is
larger. Run the candidate boundary three times from clean fixture state. The
repeatable supported maximum is the highest rate for which all three runs pass.
The reported safe operating ceiling is 70% of that maximum.

The runner must support a lower early stop if the operator observes host risk;
stopping a run must still preserve available diagnostics and destroy the
disposable environment.

## Pass/fail gates

A level fails if any condition occurs during the measured interval:

- completed critical sessions are fewer than offered sessions;
- k6 reports any `dropped_iterations`, or iterations plus dropped iterations do
  not equal configured rate times measured seconds;
- session scheduler misses any offered one-second bucket;

Race-resolution settlement, suggested-race completion, asset-manifest
completion, and the all-settled deadline are diagnostic freshness evidence, not
Home-open pass/fail gates. The shipped client completes the visible Home load
before its bounded race-resolution poll and refreshes race surfaces silently
after success. Queue lag and drain time remain reported so the Home ceiling is
not misrepresented as a race-freshness ceiling.
- unexpected HTTP 5xx, timeout, or contract-invalid rate is at least 0.1%;
- `criticalHomeMs` p95 exceeds 1 second or p99 exceeds 2 seconds;
- sync-v2 p95 exceeds 750 ms or p99 exceeds 1.5 seconds;
- legacy `/steps` p95 exceeds 2 seconds or p99 exceeds 5 seconds;
- database pool wait p99 exceeds 50 ms or any checkout fails;
- resolution p95 lag exceeds 30 seconds or the queue does not drain within
  five minutes after offered sessions stop;
- the required 2 HTTP + resolution + cron process census changes;
- any process exceeds its configured memory limit, exits unexpectedly, or
  remains unhealthy;
- offered load stops but CPU, pool waiters, or queue lag fails to recover within
  the bounded drain window.

Telemetry is required every second across warm-up, measurement, and drain.
Missing intervals, NaN values, database/collector errors, absent worker
identities, incomplete container stats, or missing generator metrics fail the
run; missing evidence can never be interpreted as healthy zero.

Redis misses are reported but are not alone a failure unless they cause one of
the user-visible or infrastructure gates above.

## API contract and data model

There is no new or changed public API contract. The primary profile calls
existing endpoints exactly as the current client does, including its explicit
legacy fallback only when sync-v2 tells that current client to downgrade. All capacity-only profile,
session, and report schemas are internal test contracts and must be versioned.

There is no migration or persistent production data change. Synthetic fixture
writes occur only inside `steps_tracker_capacity`; fixture cleanup is verified,
and destroying the Lima VM removes the disposable database.

## Implementation plan

Backend/load-harness ownership only; no Flutter production file changes.

1. In `src/modules/loadTesting/contract.js`, add the versioned `home-open`
   profile with session limits and endpoint definitions. Keep the existing
   request-weighted `home` profile unchanged for compatibility.
2. In `src/modules/loadTesting/runner.js`, extract/reuse the coherent-session
   pacing primitives from event-open and implement the exact Home sequence,
   response-dependent fallbacks, sync downgrade behavior, session timing, scheduler
   lag, and critical/all-settled accounting.
3. Add a genuine k6 script under `scripts/k6/` and a guarded Node orchestrator
   under `scripts/` following the event-open workflow. Run k6 on the host,
   outside the SUT Lima resource envelope, through the existing forwarded API
   port. Bind both to started
   lifecycle state whose profile is exactly `home-open`; reject public or
   production-looking targets and mismatched run IDs/manifests.
4. Extend the immutable JSON, text, and metrics reports with the session schema,
   gate results, retry/fallback counts, fixture topology, generator health, and boundary-ready
   summaries. Do not change old artifact schemas in place.
5. Document smoke, single-level, ladder, boundary-repeat, interruption, and
   destroy commands in `docs/capacity-load-runbook.md`.
6. Add no feature flag or production runtime control. `home-open` is an
   explicit non-production profile selected at command time.

## Tests-first plan

Before implementation, add failing tests proving:

1. Profile parsing accepts `home-open`, rejects invalid limits, and retains the
   existing `home` profile unchanged.
2. One current session performs sync-v2 before Home reads, launches the three
   Home reads concurrently, uses `homePersistedTotals=1` only when authorized,
   and applies response-dependent fallbacks.
3. Ambiguous sync-v2 retries once with the same key/body; definite unsupported
   behavior takes the exact legacy fallback; legacy daily steps retry once
   before optional best-effort samples.
4. Persistence failure marks critical failure but still launches downstream
   Home reads.
5. Resolution polling follows the cumulative bounded client schedule, includes
   successful-resolution fan-out and Home-triggered manifests, without gating
   `criticalHomeMs`.
6. A failed, timed-out, malformed, dropped, or late-scheduled critical request
   causes session failure and cannot inflate completed throughput.
7. Suggested-race or bounded resolution-poll failure affects all-settled
   evidence without falsifying critical Home completion.
8. Genuine k6 output and orchestrator summaries preserve offered/completed
   session counts and session percentiles.
9. Lifecycle guards reject production/public hosts, wrong profiles, wrong run
   IDs, missing scrub attestations, missing outbound-disable state, and wrong
   database markers before traffic begins.
10. An integration test starts a real local HTTP server with a confirmed test
    database, creates synthetic fixtures through the public setup path, runs a
    tiny coherent Home session, verifies public HTTP requests and the report,
    and cleans up. Never point it at production.
11. Immutable artifact and process/database/queue gate failures fail closed.
12. Missing telemetry intervals, incomplete process/container census, missing
    generator metrics, or inconsistent k6 offered/started/dropped arithmetic
    fail closed.

Run `npm run test:unit` and the relevant `npm run test:integration` suite only
after confirming `DATABASE_URL` identifies a dedicated test database. Never run
bare `npm test`.

## Backward compatibility and rollout

- Existing `home`, `full-app`, event, and burst profiles retain their names,
  entry weights, defaults, and artifact behavior.
- The new profile is additive and capacity-only. No frozen app calls it and no
  production server behavior changes.
- No deploy is required to run it from the local checkout.
- The capacity run uses the current checked-out backend commit and stamps that
  commit in every artifact.

## Acceptance criteria and definition of done

- The approved coherent Home sequence is implemented and covered tests-first.
- All load-testing unit tests pass; the relevant real-HTTP integration test
  passes against a confirmed test database.
- The code reviewer finds no unresolved correctness, safety, or evidence issue.
- The smoke run passes on the confirmed disposable capacity shape.
- The ladder stops automatically/manual-operationally at its first failed level,
  boundary repeats are immutable, and the environment is destroyed afterward.
- The final report states the repeatable maximum and 70% safe ceiling in Home
  opens/second (or only the proved lower bound when the hard cap passes), plus
  opens/minute, average/peak in-flight sessions, critical/all-settled latency, endpoint bottleneck,
  infrastructure bottleneck, and the limitations of converting this isolated
  result to concurrent users or DAU.
- During an active run, the operator receives a progress update at least once
  per minute containing current level, elapsed time, offered/completed/failed
  sessions, available latency, error rate, and infrastructure warning state.

## Revision log

- 2026-09-01 — Initial specification drafted from the Flutter Home orchestration
  and the existing capacity/event-open harness.
- 2026-09-01 — Gap pass 1: separated critical-render and all-settled timing;
  added response-driven Home fallbacks, resolution polling, scheduler-lag
  accounting, and explicit legacy daily-steps/sample semantics.
- 2026-09-01 — Gap pass 2: preserved the legacy request-weighted `home` profile;
  added immutable boundary repeats, recovery/drain gates, manifest provenance,
  explicit non-goals for launch-only endpoints, and the accepted runtime-version
  limitation.
- 2026-09-01 — Architect review: changed the primary workload to the exact
  current-client foreground/resume graph; removed the false Home-pull and mixed
  frozen-client model; added shipped retry/continue-on-error behavior,
  Home-triggered manifests and resolution fan-out, aggregate fixture topology,
  host-side k6 generation, dropped-iteration arithmetic, continuous evidence
  gates, clean per-level state, and a bounded geometric ladder above 100.
- 2026-09-01 — Architect re-review: corrected manifest requests to the shipped
  unconditional `200` contract, added the shop-fallback manifest trigger and
  bounded all-settled definition, and reserved/stamped containing-VM resources
  for Redis, guest/container overhead, and monitoring outside the exact
  backend/database caps.

- 2026-09-01 — Verified the shipped Flutter orchestration and revised the
  capacity gate to measure visible Home completion. Background resolution,
  manifests, and suggested-race work remain traffic-shaped diagnostics but no
  longer turn a completed Home open into a failure.
- 2026-09-01 — Frontend contract audit: corrected the current-client friends
  fallback from the historical `/friends/steps` path to the shipped
  `/friends?view=summary-v1` repository request.
