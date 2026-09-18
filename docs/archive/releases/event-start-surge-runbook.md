# Event-start surge rollout and incident runbook

This runbook documents verification and sequencing only. It does not authorize
a production deploy, database write, PM2 action, cron stop, pool change, or
infrastructure change; each of those requires fresh explicit authorization.

## Release evidence required before production

1. Preserve the frozen-client contract: `/steps` returns only `{record}`,
   `/steps/samples` returns only `{count}`, and `/steps/sync-v2` keeps its exact
   stored 202/error behavior. The push type, payload, delivery key, collapse
   identity, and deep link are unchanged.
2. Record passing sustained, shock, Redis-outage, and HTTP-worker-restart
   artifacts from the `event-open-surge` workflow in
   `docs/capacity-load-runbook.md`. The environment must use the exact pool
   budget HTTP 10 + HTTP 10 + resolution 8 + cron 4 = 32.
3. Confirm the permanent provider-admission constant of 6,000 attempts/minute
   retains at least 40% measured request-capacity headroom and completes the
   12,000-attempt production-shaped cohort within two minutes. If not, block
   release; do not change it through an environment value.
4. Confirm the additive migration applies from a clean schema and the
   notification/step integration suites pass on a dedicated test database.
5. Confirm no runtime release flag, second step command table, new participant
   writer, PM2 worker increase, or pool-ceiling change is present.

## Non-overlapping cron replacement

Perform this only in a separately authorized production operation and outside
an event boundary.

1. Record the current singleton cron PID and current notification backlog using
   read-only commands.
2. Gracefully stop the old singleton cron and wait until that exact PID has
   exited. Do not start the replacement while the old PID is live.
3. Wait through the maximum old 30-second delivery lease. The new cron's
   startup barrier then stamps any legacy global-event `PENDING`, `RETRY`, or
   expired `LEASED` work into permanent admission states while preserving
   accepted device state.
4. Start exactly one replacement cron owner. Verify the four logical identities
   remain `http:0`, `http:1`, `resolution:0`, and `cron:0`, and verify pool
   ceilings remain 10/10/8/4.
5. Verify the startup barrier reports zero legacy global-event residue before
   ordinary inbox delivery begins. Verify the lane row advances monotonically,
   first attempts precede retries, expired work becomes terminal, and no
   catch-up page appears after restart.
6. Verify `event_surge_v1` logs and the bounded Redis mirror are fresh. Redis
   failure may remove the mirror but must not stop Postgres-backed delivery.

A brief no-cron gap is safe because schedules, outboxes, target snapshots,
leases, and the release lane are durable in Postgres. Old and new cron owners
must never overlap.

## Read-only incident diagnosis

Safe diagnosis gathers, without mutation:

- request latency/error rates by endpoint class and offered/completed app-open
  sessions;
- both HTTP pools plus resolution and cron totals, idle, waiters, wait
  percentiles, and checkout failures;
- step-admission active/queued/rejected counts;
- notification schedule/outbox counts, oldest age, delivery lag, lane
  `next_token_at`, and event expiry margin;
- resolution queue oldest age and drain trend;
- CPU, RSS, event-loop delay, PostgreSQL lock waits, and Redis health.

The event is a pool/admission incident when checkout wait rises while no long
lock holder exists; longer timeouts merely retain more queued work. A Redis
outage may delay wakes but is not data loss because Postgres polling remains
authoritative.

## Mutating containment requires authorization

Do not restart PM2, stop cron, change worker counts, raise pools, resize the
database/host, update notification states, alter lane timestamps, or write a
production repair query without fresh explicit authorization. If authorized,
resolve exact targets read-only first and preserve the 10/10/8/4 budget unless
the approval record states every replacement ceiling plus managed-pool,
migration, maintenance, and direct-connection reserves.

Horizontal HTTP scale-out is a later topology phase: dedicated singleton
resolution/cron capacity, managed-pool-mode compatibility proof, a database
connection census with reserve, and a load-balancer failover gate must be
approved before adding a host. Production remains exactly two PM2 HTTP workers
on the current host until then.
