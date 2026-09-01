# Event-start surge resilience requirements

## Status

Planning only. This document does not authorize a production deploy, a
production database write, a PM2 change, or a DigitalOcean capacity change.

## Summary and user story

When a local daily steps event starts for a large timezone cohort, eligible
users should learn about it and open Bara without making the app unusably slow.
Step uploads, authentication, the home screen, and race reads must remain
available during the event-open surge, and no user's event scoring may depend
on whether their notification happened to be delivered first.

The design must work for frozen iOS and Android clients, including clients that
still call `POST /steps` and `POST /steps/samples`, while providing a scalable
path for current clients through `POST /steps/sync-v2`.

## Incident reconstruction: 2026-08-30 East Coast event

Read-only production evidence captured during the incident establishes the
following sequence:

1. Production had the intended topology: two HTTP workers, one resolution
   worker, one cron worker, and stopped staging. The host had about 5.3 GiB
   available memory, effectively unused swap, moderate CPU load, and no recent
   kernel OOM. This was not a droplet memory or missing-worker incident.
2. The local global-event operational snapshot changed from zero active
   entitlements to 517 and the cumulative `GLOBAL_EVENT_STARTED` delivered
   count advanced by roughly 496 at the East Coast boundary.
3. Clients opened or woke together and issued a screen bootstrap plus step
   upload fan-out. In the four worst minutes, `POST /steps` alone accounted for
   1,092 completions, followed by `POST /steps/samples`, `POST /steps/sync-v2`,
   races, and home-card reads.
4. Both HTTP pools reached their limit of ten. Pool checkout p95 became the
   five-second timeout; the two workers recorded 256 queued checkout timeouts
   in the latest hourly samples. Authentication and post-commit work also
   competed for the same pool.
5. At 14:59 ET, 931 requests completed with 7.57-second mean latency, 131 5xx
   responses, and a 45.18-second maximum. At 15:00, after the wave drained,
   mean latency returned to 321 ms with zero 5xx. PostgreSQL showed no blocked
   sessions and no long-running lock holder after recovery.

The proximate cause was a notification-induced thundering herd. The system
then amplified that herd because one app open produces several concurrent API
requests and the step paths hold scarce HTTP database connections while doing
multi-phase synchronous work. Increasing a timeout or restarting workers would
only make the queue longer or briefly discard it.

## Goals

- Event eligibility and scoring still begin at the exact local boundary for
  every eligible user.
- Visible start notifications are durably paced, not released as one cohort.
- A step-ingestion surge cannot exhaust the database capacity reserved for
  authentication and interactive reads.
- Canonical step/sample source data, its scoring-generation fence, and its C0
  dirty-race enqueue remain atomic before a success response.
- Expensive race projection, notifications, analytics, and other derived work
  stay asynchronous where the existing client contract permits it.
- Frozen legacy clients retain their exact response shapes and status/error
  semantics.
- The architecture has a measured capacity envelope and a scale-out path; it
  must not rely on a one-off pool-size increase.
- Redis remains an optional accelerator, never the only durable record.

## Non-goals

- No change to event multiplier, duration, eligibility, scoring order, or
  award calculation.
- No frontend visual or placement change.
- No guarantee that APNs or FCM displays a push at an exact instant.
- No destructive schema change.
- No release flag, kill switch, rollout percentage, or temporary environment
  switch. Mixed-version behavior is selected by the existing endpoint contract,
  not by a runtime flag.
- No increase beyond exactly two production PM2 HTTP workers on the current
  host. Horizontal scaling is a separately provisioned topology phase.

## Scale model and service-level objectives

Capacity must be expressed as a fan-out model rather than DAU alone:

```text
event-open API RPS = eligible cohort
                   * notification-open rate within the peak bucket
                   * requests per opened session
                   / peak bucket seconds
```

The production-like capacity fixture must include the real open sequence:
session/authentication, device-token registration, activation analytics,
`/steps` or `/steps/samples` or `/steps/sync-v2` in the observed client mix,
home race-card, discovery, race list, inbox, and race progress/bootstrap.

The first release gate is the larger of:

- 10 times the 2026-08-30 East Coast eligible cohort with the observed open
  fan-out and endpoint mix; or
- 100 event-open sessions per second for five minutes, with a separate 200
  sessions/second one-minute shock test.

This is a workload definition, not a claim that the current host can meet it.
The final delivery rate is derived from the measured sustainable admission
rate with at least 40% headroom.

During the sustained gate:

- authentication and interactive home-shell reads: p95 below 500 ms, p99 below 1 s;
- accepted `sync-v2` ingestion: p95 below 750 ms, p99 below 1.5 s;
- legacy step endpoints: p95 below 2 s, p99 below 5 s;
- HTTP pool checkout: p95 below 50 ms, zero five-second checkout timeouts;
- 5xx below 0.1%; no lost accepted uploads and no duplicate scoring;
- resolution queue lag below 30 seconds during the wave and fully drained
  within five minutes afterward;
- notification start lag p95 within the specified delivery window and no
  notification after the event expiry safety margin.

## Architecture

### 1. Preserve one canonical event boundary

`globalEventBoundaryDrain.js` remains responsible for activating entitlement
and race-impact state at the exact local boundary. Notification timing must not
change `startsAt`, `startProcessedAt`, scoring eligibility, or impact rows.

The boundary transaction must only perform the minimum set-based eligibility,
impact, and resolution-enqueue writes. It must not contact APNs/FCM, enumerate
device tokens, invalidate per-user caches in a serial loop, or wait for push
delivery.

Boundary work remains micro-batched and restart-safe. Each transaction has a
bounded row count and lock set, commits before the next page, and records oldest
due age. An East Coast-sized boundary may use several transactions, but a user
is eligible from the persisted `startsAt` even if their materialization page is
claimed seconds later. Scoring readers must interpret a due, not-yet-processed
entitlement through the existing repair path so page order cannot affect awards.

### 2. Pace notification-induced opens with deterministic durable schedules

All eligible `GLOBAL_EVENT_STARTED` schedules keep the exact existing payload
and boundary `availableAt`, plus deterministic admission ordering after the
scoring boundary.
The ordering key is a stable hash of `(eventId, entitlementId, userId)` so a
retry or rolling deploy cannot reshuffle users.

The delivery controller uses a permanent capacity policy:

- event scoring starts immediately for everybody;
- pushes are released in small pages under a global token bucket;
- the release rate is the lower of the tested safe open-admission rate and the
  provider-safe delivery rate;
- unused capacity may be borrowed by later pages, but a restart reconstructs
  the same schedule from durable timestamps;
- retries use the existing durable retry rules and do not jump ahead of first
  attempts;
- schedules that cannot be useful before `endsAt - safetyMargin` expire rather
  than causing a late surge.

Add one durable `NotificationReleaseLane` row per notification class. Its
fenced lease, `nextTokenAt`, and fence generation coordinate the singleton cron
owner today and remain correct if delivery workers later move hosts. A release
transaction consumes at most the tokens accrued since the previous committed
`nextTokenAt`. Process time or restarts cannot create a catch-up blast: token accrual
is capped to one normal page, and the remaining rows stay ordered by
`(availableAt, id)`. This is durable rate shaping, not an in-memory timer.

The initial production constant is not chosen by intuition. It is calculated
from the measured distribution from provider acceptance to app-open requests,
including users who never open, delayed opens, background wakes, and multi-device
users. One push is not modeled as one immediate session. The resulting rate is
committed with the evidence. Changing it is a code change with review, not an
environment toggle. The target delivery window is
at most five minutes for the initial cohort; if the measured safe rate cannot
deliver the forecast cohort inside that window with 40% headroom, the release
is blocked until backend capacity is increased.

Because event scoring covers steps taken during the whole event window, a user
whose push arrives later does not lose eligible steps. Product copy remains
accurate (`event is live`) and does not promise an exact notification instant.

### 3. Remove per-recipient release amplification

`notificationDelivery.releaseDue()` already materializes schedule pages
set-wise, but then publishes a Redis wake and unread-cache invalidation once per
recipient. Replace this with one bounded batch wake and one set-based or
versioned cache invalidation operation. A lost Redis wake is harmless because
Postgres polling remains authoritative.

Pacing continues through the final provider-attempt boundary. Event outbox rows
and their retryable device attempts retain the same admission class, stable
sequence, and event expiry as their schedules. `inboxDelivery.js` may claim an
event first attempt or retry only after atomically consuming that lane's durable
token. A provider outage therefore accumulates pending work but cannot create a
catch-up blast on recovery. First attempts and retries share the lane budget and
accepted devices are never retried. Due first attempts always precede retries:
the allocator will not claim `ADMISSION_RETRY` while any due
`ADMISSION_PENDING` schedule is unmaterialized, and within the outbox it claims
all due `ADMISSION_FIRST` rows before `ADMISSION_RETRY`. `endsAt - safetyMargin`
propagates only to schedule/outbox/device push delivery. `InboxAlert` keeps its
existing 30-day visibility contract.

`inboxDelivery.js` must claim a page in one short fenced transaction, snapshot
device targets set-wise for that page, commit, and only then perform provider
I/O. It must not open one claim transaction per row with concurrency 16. Final
provider results are written in bounded set-based batches. APNs/FCM concurrency
and database-write concurrency are independent controls in code.

### 4. Shorten the existing canonical step-intake transaction

Do not add a second step-ingestion command table or worker. Production already
has the required durable boundaries:

- `StepSyncRequest` owns sync-v2 idempotency and stored-response replay;
- `stepInputIntake` atomically upserts canonical daily/sample source data,
  advances the scoring-input generation, and enqueues dirty races;
- the race-keyed C0 queue and its lease token are the sole ownership fence for
  bulk `race_participants` writes.

These remain the only source of truth. HTTP persists canonical source plus the
C0 enqueue in one transaction and returns the existing persisted record/queue
response. Only C0 performs race projection, participant mutation, box/powerup
reconciliation, and settlement-adjacent work. No generic `SKIP LOCKED` consumer
may write participant state.

Optimize `stepInputIntake` rather than wrapping it in another queue:

1. Measure query count and hold time for scoring-state lock, daily read/upsert,
   canonical sample read/reconcile, active-race discovery, generation update,
   C0 enqueue, and sync-v2 summary capture.
2. Remove duplicate canonical sample reads by having reconciliation return the
   exact post-write watermarks/coverage needed by the generation decision, with
   parity tests for no-op, overlap, manual-source, and boundary cases.
3. Make active-race discovery and dirty-envelope construction one bounded
   set-based query whose cost grows with the uploader's active races, not the
   size of those races.
4. Keep C0 enqueue atomic but merge already-queued generations and dirty scope
   through the existing race-keyed fence, never by adding a second job family.
5. Keep `lastStepSyncAt`, cache invalidation, domain-event emission, analytics,
   provider work, and all race-wide computation after commit and best-effort.
6. Audit sync-v2 summary capture locks separately; split only derived capture
   work that can be recovered from `StepSyncRequest` without changing the
   stored 202 response or event-summary correctness.

Legacy `/steps` returns only `{record}` and `/steps/samples` returns only
`{count}`; neither contract requires synchronous race or box reconciliation.
They use the same canonical intake and C0 enqueue, with no invented compatibility
finalizer. Sync-v2 retains `StepSyncRequest`, exact idempotency behavior, and its
existing 202 body.

### 5. Bulkhead database capacity by workload

One shared HTTP pool currently allows step ingestion to starve auth and reads.
Split the committed database budget into explicit permanent roles:

- `http`: auth, session, home/race/inbox reads, and canonical step intake;
- `resolution`: the only C0 race projection/participant writer and settlement
  worker;
- `cron-notification`: event boundaries, schedule release, and delivery state.

Within each HTTP worker, request-class admission happens before acquiring a
database client. A bounded step-intake semaphore is deliberately
smaller than the worker's pool, leaving a tested minimum interactive reserve.
This application-level reservation is required because a plain `pg.Pool` has
no priority or reserved-slot semantics. Separate telemetry reports HTTP ingest
and interactive waiters even though they share the process pool. Raising every
pool maximum is prohibited as a solution.

The current aggregate is fixed at `2 * 10 HTTP + 8 resolution + 4 cron = 32`.
No role ceiling or topology changes until a post-capacity-test approval record
states the exact new ceilings, managed-pool usable capacity, direct-connection
reserve, and migration/maintenance reserve. Any approved change updates the
strict role resolver, startup aggregate-budget guard, telemetry role identities,
ecosystem definition, PM2 topology guard, and deploy runbook atomically.

The load-tested current-host candidate is exact: each HTTP worker retains pool max
10, admits at most eight concurrent step POST requests, and therefore leaves at
least two pool slots outside step intake. All Postgres-backed auth, app-setting,
intake, summary-capture, and post-commit operations inside one admitted request
are made sequentially; existing parallel app-setting reads are removed or
replaced by one combined read. A request holding one permit may have at most one
checked-out connection at a time, and the permit is not released until all
request-owned Postgres work is complete. Capacity
tests may reject this candidate, but no different value is committed or
deployed without updating this document's post-test approval record. The
semaphore queue is capped at 128 requests per worker with a 2,000 ms wait; overflow
or expiry returns the endpoint-specific 500 contract before auth and DB access.

### 6. Protect read availability

Do not add an unbounded auth or home cache program in this workstream. Preserve
the reviewed ten-second assembled `/auth/me` cache and its existing invalidation
inventory. First use request coalescing and endpoint fan-out reduction where
responses already have defined cache contracts. Any future `requireAuth` user
cache or home/race read model requires a separate specification with a pinned
safe-field allowlist, security/account invalidation inventory, versioned
environment-prefixed keys, TTL/staleness bound, local Redis-db15 and
`REDIS_URL`-unset tests, and Postgres fallback on every Redis error.

### 7. Horizontal scale-out topology

After request transactions are short and workloads are bulkheaded, scale HTTP
capacity horizontally behind a DigitalOcean load balancer rather than adding
PM2 workers beyond the current host's reviewed count.

- Each app host runs only HTTP roles and has health/readiness checks that fail
  when its interactive reserve is unavailable.
- Resolution and cron/notification remain singleton logical owners enforced by
  durable leases; they move to dedicated worker capacity before adding a second
  app host.
- The managed PostgreSQL/PgBouncer pool is sized from the sum of all declared
  role budgets plus migration/maintenance reserve. Direct `max_connections` is
  never treated as usable application capacity.
- Before horizontal scale, record whether the managed endpoint is session or
  transaction pooling and prove Prisma/adapter prepared-statement compatibility
  under that exact mode. Do not infer pooler behavior from the hostname.
- Redis remains shared, namespaced, disposable cache/wake infrastructure.
- Load balancing uses no session affinity; all idempotency and leases are
  durable and cross-host safe.
- Production retains exactly two PM2 HTTP workers per current host unless a
  separately reviewed host shape proves a different count.

Horizontal scale is the last phase, not a substitute for shortening the
transactions that exhausted the current pools at modest RPS.

### 8. Admission control and graceful degradation

Every process exports current pool wait, request-class concurrency, step-intake
admission wait/rejection count, notification queue age, and resolution lag. Admission is based on
local bounded concurrency, not a global runtime switch.

Admission middleware is mounted on the three POST step routes before
`requireAuth`; rejected requests parse only the already-bounded request metadata
and acquire zero database connections. There is no new total-HTTP admission
layer in this scope; the step ceiling alone protects the remainder of the pool.

When step-intake capacity is full, new work waits only for a short bounded
deadline and then receives the endpoint's exact existing overload response.
Interactive reads retain their reserved connections. Optional analytics remain
post-commit and best-effort under their existing behavior; this plan does not
remove home response fields. Auth, balances, event eligibility, and canonical
step durability are never degraded.

## API contract

No client-facing endpoint changes in the first implementation. No existing
endpoint, required request field, response field, status code, or error body is
removed or repurposed.

### Existing `POST /steps/sync-v2`

The existing request remains a JSON daily total plus optional samples, with the
existing required `Idempotency-Key`, version/feature headers, timezone handling,
and 64 KiB encoded-body limit. Success remains `202` with the stored response:

```json
{
  "record": { "id": "string", "userId": "string", "date": "ISO-8601", "steps": 0, "stepGoal": 5000 },
  "sampleCount": 0,
  "uploaderReconciliation": { "state": "DEFERRED", "resolvedRaceCount": 0, "boxStateCurrent": false },
  "raceResolution": { "jobId": "string-or-null", "generation": "number-or-null", "state": "QUEUED", "requestedAt": "ISO-8601" },
  "stepIntakeSemantics": "CANONICAL_SOURCE_QUEUE_V1"
}
```

The already-feature-gated optional `globalEventSummaryWork` remains unchanged.
The exact existing errors remain:

- `400 {"error":"<validation message>","code":"INVALID_STEP_SYNC"}`;
- `409 {"error":"Idempotency key already used","code":"IDEMPOTENCY_CONFLICT"}`;
- `413 {"error":"Step sync request too large","code":"STEP_SYNC_TOO_LARGE"}`;
- existing pre-write `503 {"error":"Step sync temporarily unavailable","code":"ASYNC_DISABLED"}`;
- `429` cooldown with `Retry-After`, `Cache-Control: no-store`, and the existing
  `STEP_SYNC_COOLDOWN` body;
- existing auth `401` bodies from `requireAuth`;
- `500 {"error":"Internal server error"}` for admission timeout or any
  pre-commit server failure.

Admission rejection happens before auth and returns that same 500 body with no
new header, preserving frozen-client behavior. A failure after canonical source
and C0 enqueue commit is best-effort/logged and must not turn the committed 202
into a 500. Same-key replay returns the stored 202 body exactly.
The plan adds no new kill switch; it preserves the existing operational intake
brake and its frozen-client 503 contract.

### Existing `POST /steps` and `POST /steps/samples`

`POST /steps` keeps request `{steps,date,skipRaceResolution?}` and success:

```json
{"record":{"id":"string","userId":"string","date":"ISO-8601","steps":0,"stepGoal":5000}}
```

Missing `steps` or `date` remains
`400 {"error":"steps and date are required"}`. Admission timeout and any other
pre-commit server failure remain `500 {"error":"Internal server error"}`.

`POST /steps/samples` keeps request
`{samples:[{periodStart,periodEnd,steps,recordingMethod?}]}` and success
`200 {"count":<accepted sample count>}`. Existing `StepSampleError` validation
continues to return its current status (normally 400) and
`{"error":"<existing message>"}`; admission timeout and other pre-commit server
failures remain `500 {"error":"Internal server error"}`.

Both endpoints retain existing auth 401 responses. Admission rejection is
before auth, performs zero database calls, and deliberately uses the existing
generic 500 body. No new required header, parameter, synchronous box refresh,
or response field is introduced. Post-commit bookkeeping/cache/event failures
are logged and do not change a successful response.

### Internal notification release contract

```js
releaseEventNotificationPage({
  admissionClass: "visible:GLOBAL_EVENT_STARTED",
  now,
  maximumRows
}) -> {
  examined,
  materialized,
  expired,
  nextScheduleAt
}
```

Schedule materialization is set-based and never sends to a provider. The final
provider claim calls the fenced lane allocator:

```js
claimProviderAttemptPage({ admissionClass, now, maximumRows }) -> {
  claimed,
  nextTokenAt
}
```

Only this second operation consumes rate tokens. It covers first attempts and
retries and returns rows already fenced with outbox lease tokens.

## Data model and migrations

### Notification schedules

Use the existing notification tables with these additive fields:

- `notification_schedules.admission_class varchar(64) null`;
- `notification_schedules.admission_sequence bigint null`, set once to the
  unsigned first 63 bits of SHA-256 over the existing `deliveryKey`;
- `inbox_delivery_outbox.admission_class varchar(64) null`;
- `inbox_delivery_outbox.admission_sequence bigint null`;
- `inbox_delivery_outbox.admission_expires_at timestamptz null`.

Admitted event work uses permanent version-stamped states that old code does
not select:

- schedule: `ADMISSION_PENDING` -> `MATERIALIZED` (or an existing terminal
  canceled/expired state);
- outbox first attempt: `ADMISSION_FIRST` -> `ADMISSION_LEASED` -> `DELIVERED` or
  `ADMISSION_RETRY`/terminal;
- outbox retry: `ADMISSION_RETRY` -> `ADMISSION_LEASED` -> `DELIVERED` or
  `ADMISSION_RETRY`/terminal.

Old schedule release selects only `PENDING`; old inbox delivery selects only
`PENDING`, `RETRY`, and expired legacy `LEASED`, so it cannot claim admitted
work, including expired admitted leases.

`GLOBAL_EVENT_STARTED` projection sets class
`visible:GLOBAL_EVENT_STARTED`, the stable sequence, and
schedule `expiresAt = entitlement.endsAt - safetyMargin`. Materialization copies
that value to outbox `admissionExpiresAt`, while `InboxAlert.expiresAt` remains
the existing 30-day value. Non-event rows keep null and preserve current
delivery behavior. The existing delivery key and event collapse ID are
unchanged through retries.

Add `notification_release_lanes`:

- `admission_class varchar(64) primary key`;
- `next_token_at timestamptz not null`;
- `created_at/updated_at timestamptz not null`.

The initial lane row is inserted idempotently with `nextTokenAt = migration
transaction_timestamp()`. Its rate `R` is a reviewed integer attempts per
minute chosen so it divides 60,000,000 exactly. Token spacing is therefore the
integer `deltaMicros = 60,000,000/R`, evaluated with PostgreSQL microsecond
timestamp arithmetic without floating-point accumulation. The allocator starts one short
transaction, locks the lane row with `SELECT ... FOR UPDATE`, calculates
available tokens, leases the selected outboxes, advances `nextTokenAt`, and
commits. PostgreSQL row-lock ownership is the complete fence: a crashed
transaction rolls back, a waiting owner proceeds after lock release, and there
is no stale application lease to renew. Available tokens are
`min(pageSize, 1 + floor((now-nextTokenAt)/delta))` when due. If downtime put
`nextTokenAt < now-pageSize*delta`, the allocator rebases it to `now` before
claiming, preventing accumulated credit. It first drains due
`ADMISSION_PENDING` schedules set-wise. If any due schedule remains, no retry
is eligible. It then claims `(availableAt, admissionSequence, id)` from
`ADMISSION_FIRST`; only when no due first attempt exists may it use remaining
tokens for `ADMISSION_RETRY` or an expired `ADMISSION_LEASED` row. An expired
admitted lease represents an uncertain provider attempt and must consume a new
token before it is re-leased; it never falls back to legacy `RETRY`. Consuming
`k` tokens advances `nextTokenAt` by `k*deltaMicros` and changes the same `k`
rows to `ADMISSION_LEASED` with fresh lease tokens. Completion, retry, and
terminal updates must match both `status = ADMISSION_LEASED` and the exact row
lease token.

Indexes are:

- schedules `(admission_class, status, available_at, admission_sequence, id)`;
- outbox `(admission_class, status, available_at, admission_sequence, id)`;
- existing non-admitted outbox claim index remains.

Already-pending global-event schedules are backfilled set-wise to
`ADMISSION_PENDING` with class, stable sequence, and expiry when their source
entitlement is present. Existing global-event outboxes in `PENDING` become
`ADMISSION_FIRST`; those in `RETRY` become `ADMISSION_RETRY`; terminal/history
rows are untouched. After the old cron owner exits and its maximum legacy lease
deadline passes, expired global-event `LEASED` rows become `ADMISSION_RETRY`
while preserving accepted-token/device-attempt state and receiving admission
class, stable sequence, and safety expiry. A permanent reconciler applies the
same stamping to any legacy global-event row found in `PENDING`, `RETRY`, or
expired `LEASED`, repairing mixed-version crash residue. Migration tests run
the old notification code against the new
schema and prove it cannot claim stamped work. All additive columns remain
nullable for old reads/writes, but behavioral compatibility comes from the new
states, not nullability. No step-ingestion migration is added.

## Frontend plan

The first two phases require no frontend release. Existing iOS and Android
push payloads, deep links, step responses, and screens remain unchanged.

A later separately specified client may consume convergence metadata, but the
first implementation adds none. Demo and tutorial screens require no changes.

## Backward compatibility and rollout

1. Land observability and production-like capacity fixtures first; no behavior
   change.
2. Land the additive notification schema, version-stamped states, allocator,
   reconciliation, and set-based delivery as one compatibility unit. Frozen
   clients receive the same push type and route, spread within the event window.
3. Production cron replacement is deliberately non-overlapping: outside an
   event boundary, gracefully stop the old singleton cron, verify its PID has
   exited, start the new cron definition, and verify the stamped-state
   startup barrier plus lane health before continuing. The new cron waits out
   the maximum old lease, reconciles all legacy global-event `PENDING`, `RETRY`,
   and expired `LEASED` rows, asserts the residue count is zero, and only then
   starts ordinary inbox delivery. A brief background-worker gap
   is recovered from Postgres; an old and new cron may never overlap. This is a
   separately approved production operation and the safe-reload wrapper/runbook
   must encode it before deploy.
4. Shorten `stepInputIntake` one measured phase at a time while retaining
   canonical source, generation fence, and C0 enqueue in the transaction.
5. Mount pre-auth step admission only after integration tests prove rejected
   requests acquire zero database connections and all endpoint bodies match.
6. Introduce the reviewed HTTP admission ceilings within the existing pool
   budget only after the capacity profile proves the allocation.
7. Provision dedicated worker capacity and a second HTTP host only after the
   database pool census proves reserve. Production infrastructure changes need
   separate explicit authorization.

No phase uses a release flag. Additive data/version stamps and endpoint-specific
permanent behavior provide mixed-version compatibility. Deploy backend before
any optional frontend consumer.

## Tests-first implementation plan

Tests must use dedicated local/test Postgres and disposable Redis. Never run
them against production.

### Incident replay and capacity

- Add a production-like event-open profile that schedules a timezone cohort,
  activates the boundary, delivers pushes, and generates the observed complete
  app-open request graph.
- Assert offered and completed session rates separately; dropped work is a
  failure, not hidden throughput.
- Export per-request-class latency, pool waits/timeouts, admission wait/rejects,
  notification lag, resolution lag, and database connection census.
- Current-host gate: run sustained, shock, Redis-outage, and worker-restart
  profiles. Later multi-host gate: add one-HTTP-host-loss and load-balancer
  failover profiles.

### Notification pacing

- Integration test through real entitlement -> domain event -> schedule ->
  alert/outbox -> provider path.
- Prove scoring begins at one boundary while deterministic notifications span
  the delivery window.
- Prove release-lane fencing, capped token accrual after downtime, and monotonic
  progress prevent two workers or a restart from producing a catch-up blast.
- Prove retry/restart stability, no late sends, exact existing payloads,
  duplicate safety, and Redis-loss recovery.
- Migration compatibility test: run the old release/delivery implementation
  against the expanded schema and prove it cannot claim version-stamped work.
- Extend that test through an expired `ADMISSION_LEASED` row and prove only the
  new allocator can recover it after consuming another durable token.
- Simulate an old worker stopped during provider I/O; after its legacy lease
  expires, prove the startup barrier converts `LEASED` to `ADMISSION_RETRY`
  without losing accepted-device state and before ordinary delivery starts.
- Prove due first attempts block retries, alert visibility remains 30 days, and
  schedule expiry maps exactly to outbox/device delivery expiry.
- Prove release uses bounded set-based statements and does not publish one wake
  per recipient.
- Prove a cohort ten times the incident size does not increase HTTP pool waits.

### Canonical step intake

- Real-HTTP integration tests prove canonical daily/sample persistence,
  scoring-generation fencing, and C0 enqueue commit together before success.
- Prove sync-v2 same-key response replay and different-hash 409 behavior remain
  exact after crashes/retries.
- Prove `sync-v2` responds without waiting for race-wide projection.
- Prove legacy `/steps` and `/steps/samples` preserve exact success, validation,
  auth, admission-timeout, and server-error bodies.
- Instrument pool ownership in a two-worker integration harness and assert at
  most four simultaneous step-attributable checkouts per worker, including
  auth, app-setting, intake, summary, and post-commit phases.
- Prove no-op, overlap, lower/higher value, timezone boundary, and concurrent
  uploads cannot lose canonical input or double score.
- Prove provider, analytics, cache, and post-commit bookkeeping failures cannot
  roll back canonical source plus C0 enqueue or turn it into a 5xx.
- Structural guard: no writer other than the fenced C0 resolution path performs
  bulk `race_participants` projection updates.

### Bulkheads and scale-out

- Saturate step intake and assert auth/home retain their SLO and reserved
  capacity; admission-rejected requests must show zero DB checkouts.
- Saturate reads and assert canonical step intake remains atomic and durable.
- Prove total declared role pools plus maintenance reserve stay within the
  managed pool budget at startup and after rolling replacement.
- In the later multi-host phase, run two HTTP hosts with no affinity and prove
  idempotency, C0 leases, and existing cache invalidation are cross-host safe.

## Observability and operations

Add a versioned `event_surge_v1` structured log record per minute and mirror its
bounded aggregates into the existing environment-prefixed Redis telemetry used
by admin system health. Redis stores only recent operational aggregates with
the existing telemetry TTL; it is not authoritative. `REDIS_URL` unset or any
Redis error falls back to logs and must not affect requests. Do not add a
Postgres telemetry table or request-path telemetry write.

- event/cohort identity and eligible count;
- schedules pending/materialized/expired and delivery lag p50/p95/p99;
- app-open session estimate and endpoint fan-out;
- request-class active/queued/rejected counts;
- per-role pool total/idle/waiting/timeouts;
- step-intake admitted/rejected/succeeded/failed and admission wait;
- resolution queue oldest age;
- HTTP latency/error rates by endpoint class.

Alert before user-visible collapse: any pool checkout p95 above 100 ms for two
minutes, any checkout timeout, interactive p95 above one second, step-admission
rejection above the tested envelope, resolution age above 30 seconds, or
notification release unable to finish before the event expiry margin.

The incident runbook must distinguish safe read-only diagnosis from mutating
containment. It must not recommend direct PM2 restarts, pool increases, cron
stops, or production DB updates without explicit authorization.

## Acceptance criteria and definition of done

- The incident replay meets every SLO at the required sustained and shock
  loads with at least 40% measured headroom.
- Event scoring starts simultaneously and notification delivery is paced
  deterministically within the approved window.
- Step ingestion cannot consume the interactive database reserve.
- Every success response corresponds to committed canonical source data,
  scoring-generation state, and C0 enqueue; sync-v2 retains durable idempotency.
- Frozen app versions retain their existing endpoint and push behavior.
- Redis outage and worker restart cause delay but no loss or duplicate scoring.
  The separately gated multi-host phase also survives one HTTP host loss.
- The managed database connection budget retains explicit migration and
  maintenance reserve.
- Relevant backend integration suites pass, followed by `npm run test:unit`;
  never run bare `npm test`.
- Architect review has no unresolved REQUIRED findings.
- Production deployment and infrastructure changes remain separately approved
  operations.

## Exact implementation order and file map

1. Incident profile and telemetry:
   `src/modules/loadTesting/`, `src/shared/observability/`,
   `src/modules/admin/`, and matching integration tests.
2. Deterministic pacing and batch release:
   `src/modules/notifications/services/domainEventV1Projection.js`,
   `notificationDelivery.js`, `jobs/notificationScheduleRelease.js`,
   `src/modules/inbox/jobs/inboxDelivery.js`, Prisma migration, and notification
   integration tests.
3. Canonical intake shortening:
   `src/modules/steps/services/stepInputIntake.js`, sample reconciliation,
   sync-v2 summary capture, existing step commands/routes, C0 enqueue, and
   real-HTTP parity tests. No new command table or participant writer.
4. Pre-auth admission and bulkhead telemetry:
   `src/modules/steps/routes/steps.js`, new shared admission middleware,
   request/step telemetry, admin health, and saturation tests. Pool/topology
   files change only if the later explicit allocation gate approves them.
5. Infrastructure scale-out:
   deployment/runbook/topology guard changes after separate approval, then
   failover and capacity verification.

## Revision log

- Initial draft: reconstructed the East Coast incident; separated push pacing,
  notification batching, durable step ingestion, workload bulkheads, read
  protection, and horizontal scaling; preserved old-client contracts and the
  production connection budget.
- Gap pass 1: removed speculative client API additions; made notification rate
  shaping durably fenced and restart-safe; bounded event-boundary transactions;
  added command payload/security limits and explicit no-catch-up-blast tests.
- Gap pass 2: replaced an unrealizable priority-pool abstraction with explicit
  pre-checkout admission and a dedicated ingestion worker; required the new
  worker to fit inside the existing aggregate connection budget; added an exact
  managed-pool-mode compatibility gate before horizontal scale.
- Architect review (`REVISE`): removed the duplicate ingestion command/worker
  and preserved `StepSyncRequest` plus canonical intake/C0 ownership; extended
  durable pacing through provider retries; specified the notification schema,
  lane arithmetic, indexes, and expiry propagation; moved admission before auth
  with exact legacy/sync-v2 responses; removed unbounded new cache surfaces;
  pinned surge telemetry to logs plus bounded Redis; separated current-host and
  later multi-host gates.
- Post-architect gap pass 1: normalized notification timing names to the
  existing `availableAt` plus admission sequence and removed the obsolete lane
  cursor; added the current-host admission bulkhead, later capacity-tested at
  4 active, 128 queued, and 2 seconds while retaining six pool slots per worker
  for interactive traffic.
- Post-architect gap pass 2: removed unspecified home-response degradation,
  repaired alert thresholds, and verified the first release has no new client
  endpoint, no second step source of truth, and no new runtime flag.
- Architect re-review (`REVISE`): added version-stamped schedule/outbox states
  old workers cannot claim and a no-overlap cron replacement; made first
  attempts precede retries without shortening Inbox alert retention; simplified
  lane fencing to one PostgreSQL row-lock transaction; made the three-checkout
  step reserve enforceable by sequential DB work; pinned the sync-v2 semantics
  literal and preserved the existing pre-write 503 intake-brake contract.
- Final architect edge-case pass: replaced legacy `LEASED` with permanent
  `ADMISSION_LEASED`, required token-charged recovery of uncertain expired
  attempts, and changed rate arithmetic to exact integer microseconds.
- Final migration-residue pass: added a startup barrier that waits out and
  stamps expired legacy `LEASED` global-event work before enabling delivery.
