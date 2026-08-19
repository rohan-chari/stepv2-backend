# pm2 cluster scaling plan

Status: **IMPLEMENTED AND LIVE IN PROD, 2026-08-15, commit `d23ec2e`.**
Written earlier the same day after a k6 load test against staging exposed
the ceiling this plan addresses; validated on a staging clone of prod data
across three load-test runs, then shipped to prod. Both `steps-tracker` and
`steps-tracker-staging` now run 2 pm2 cluster instances with the
`NODE_APP_INSTANCE === "0"` cron guard live. See the "What actually shipped"
section at the bottom for the final state; everything above it is the
original pre-implementation plan, kept for the reasoning trail.

> **Historical load-test reference:** The frontend
> `k6/staging-load-test.js` harness cited below was retired in 2026-08. The
> dated measurements remain evidence for this plan, but the command is not a
> current capacity workflow. Use the frontend repository's `k6/README.md` for
> the supported smoke/find/confirm/soak workflow.

## How we got here

A k6 load test against staging (the since-retired
`k6/staging-load-test.js` in the frontend repo) on 2026-08-15 found two
stacked bottlenecks on the droplet
(`167.172.225.16`, 2 vCPU / 2 GB RAM / 60 GB disk as of today, shared by
`steps-tracker` (prod) and `steps-tracker-staging` as separate pm2
processes):

1. **nginx `worker_connections 768`** — a stock default, never bumped when
   the droplet was upgraded from 1 to 2 vCPUs. At ~650-700 concurrent
   requests, nginx started refusing to open upstream sockets at all
   (`"768 worker_connections are not enough"`, 8,277 occurrences in the test
   window). Clients saw raw connection resets, not slow responses — nginx
   never even asked the app. **Fixed same day**: `worker_connections 4096`,
   `worker_rlimit_nofile 65535` added, config validated (`nginx -t`) and
   reloaded (`systemctl reload nginx`, zero downtime).

2. **`steps-tracker-staging` runs as exactly 1 pm2 process**, despite
   `exec_mode: cluster_mode`. With nginx fixed, re-running the same load test
   at 1500 VUs pushed 52% failure rate — but this time as real `502`s from
   nginx (27,164 of them) because the single Node process's listen backlog
   couldn't keep up, not app crashes (0 pm2 restarts, healthy the whole run).
   **This is the current ceiling** — a single-threaded event loop and single
   OS accept queue, regardless of how many vCPUs the box has.

## Why it's pinned to 1 instance today

`src/index.js` calls `app.listen(...)` and then unconditionally runs
`startCrons()` (~17 schedulers: race expiry, seeded-race renewal, ranked
computation, live placement broadcast, race resolution worker, payout
double reconcile, notification cleanup, etc.) on *every* pm2 worker that
boots. There is no `NODE_APP_INSTANCE` guard. Scaling `instances` up today
would run every one of those jobs redundantly on each worker — duplicate
race resolutions, duplicate pushes, duplicate payout processing. There's
already a real precedent for this class of bug causing an outage (see
[[cron-dedup-no-advisory-locks]] in project memory, commit `3e6c827`), which
is presumably why `instances` has stayed at 1.

## The fix

**1. Gate cron scheduling to one worker, deterministically — no distributed
locks.**

```js
if (process.env.NODE_APP_INSTANCE === "0") {
  startCrons();
}
```

pm2 sets `NODE_APP_INSTANCE` to `"0"`, `"1"`, ... per cluster worker.
`app.listen()` still runs in every worker — all workers serve HTTP, pm2's
cluster master round-robins connections across them. Only worker `0`
schedules jobs. This is deterministic (unlike advisory locks / CAS, which is
exactly the failure mode the prior outage warns against) and needs no new
infrastructure.

**2. Bump `instances` to 2** (one per vCPU) via the ecosystem config, or
`pm2 scale steps-tracker-staging 2` for a one-off. Roll out staging first,
confirm cron output appears exactly once per tick across both processes'
logs, run it through a normal day, then repeat for prod.

## Preconditions to check before rolling this out — not after

1. **RAM budget.** Staging alone is already ~628-658 MB resident with 1
   instance. Doubling instances roughly doubles that process's footprint.
   The box has 1967 MB total and **zero swap configured**. Doubling both
   staging and (eventually) prod could approach or exceed physical RAM with
   no swap cushion — meaning OOM-killer, not graceful degradation. Decide
   up front: staging goes to 2 instances now, prod stays at 1 until RAM is
   verified or added? Or add swap as a safety net first regardless?
2. **In-memory state that assumes a single process.** Anything cached in a
   plain JS variable (not Redis/DB) — in-flight idempotency-key dedup, any
   in-process locks around race resolution's `onCommitted` recompute — will
   silently misbehave split across 2 independent processes that don't share
   memory. The Redis derived-data layer ([[redis-derived-data-layer-build]])
   externalizes some of this already, but it needs an actual audit against
   the current codebase, not an assumption that it covers everything.
3. **Verify the guard itself works as expected** in this pm2 version/config
   before trusting it — confirm `NODE_APP_INSTANCE` really is `"0"` /
   `"1"` as strings, not `undefined` for both. Getting this wrong either
   double-runs every cron again or silently loses them entirely (no crons
   running at all is the quieter, worse failure — it wouldn't error, races
   would just stop resolving).

## Rollout sequence

1. Add the `NODE_APP_INSTANCE === "0"` guard, ship to staging at `instances:
   1` first (no behavior change) — confirms the guard logic doesn't
   accidentally suppress crons at instance count 1.
2. Bump staging to `instances: 2`. Watch for a day: cron logs fire once per
   tick, no duplicate race resolutions/pushes, memory stays within budget.
3. Repeat for prod once staging has soaked cleanly.
4. Re-run the k6 harness against 2-instance staging to find the new ceiling
   (this current plan doesn't itself promise the ceiling — it just removes
   the single-process cap; CPU/RAM/DB connection limits could be the next
   wall).

## Future: when traffic is a lot larger than this

Vertical scaling (more vCPUs/RAM on one droplet, more pm2 instances on it)
has a ceiling — eventually crons and web traffic need to stop competing for
the same box entirely. When that point is reached (a decision to make with
real traffic data, not preemptively):

- **Crons move to their own dedicated droplet.** All ~17 schedulers run
  there and nowhere else — the `NODE_APP_INSTANCE === "0"` guard above
  becomes moot because there's only ever one process that runs crons,
  full stop, on a box that does nothing else. Removes cron CPU/memory
  spikes (e.g. the O(all races) 5-minute `placementRecompute`, the O(all
  active races) resolution `onCommitted` recompute) from competing with
  request-serving capacity.
- **Web/API traffic load-balances across 2+ app droplets**, each running
  only the HTTP-serving Node processes (no crons at all — controlled by an
  env flag or simply not importing the cron-start path on that deploy
  target). A load balancer (DigitalOcean's managed LB, already present per
  the droplet's browser tab seen during this investigation — "Load Balancer
  for Bara" — worth checking whether it's already wired up or just
  provisioned) sits in front, health-checks `/health` on each droplet, and
  distributes traffic.
- This also finally separates prod and staging onto genuinely different
  hardware, removing the current shared-single-vCPU risk noted in
  [[capacity-ceiling-load-test]] and [[nginx-worker-connections-bottleneck]]
  where a staging load test can contend with prod's CPU/connections because
  they're colocated.
- Needs before it's real work (not just a note): a decision on DB connection
  pooling across more app processes (current Postgres `max_connections` is
  50, already shared with an unrelated `stock-sentiment` cluster per
  [[capacity-ceiling-load-test]] — more droplets means more connections
  unless pooled centrally, e.g. pgbouncer), and a real shared-state story
  for anything still relying on single-process in-memory assumptions (see
  precondition 2 above — that problem gets strictly harder, not easier,
  once crons and web are on fully separate machines).

## What actually shipped (2026-08-15)

The guard from "The fix" above went in exactly as planned:
```js
if (process.env.NODE_APP_INSTANCE === "0") {
  if (cronStartDelayMs > 0) {
    logger.log(`[CRON] Job scheduling starts in ${cronStartDelayMs / 1000}s`);
    setTimeout(startCrons, cronStartDelayMs);
  } else {
    startCrons();
  }
} else {
  logger.log(`[CRON] Skipping cron scheduling on NODE_APP_INSTANCE=${process.env.NODE_APP_INSTANCE}`);
}
```
Committed as `d23ec2e` on `main` (message: "Gate cron scheduling to pm2
worker 0 so instances can scale past 1"), deployed via the normal flow
(`git pull`, `prisma migrate deploy` — no-op, `prisma generate`, `pm2
reload steps-tracker`, then `pm2 scale steps-tracker 2`). Verified live via
`/proc/<pid>/environ` (not just logs — pm2 6.0.14 has a cosmetic bug where
two cluster workers can briefly share one log file path after certain
restart sequences, which made the logs alone ambiguous): the worker with
`NODE_APP_INSTANCE=0` runs every scheduler, the `=1` worker skips, zero
duplicate scheduling, zero crashes, RAM stayed healthy (657MB available
after scaling both prod and staging).

**The bigger finding while validating this on staging**: pm2 instance count
almost didn't matter next to a separate nginx bug that turned out to be the
*real* dominant bottleneck. Both vhosts had `proxy_set_header Connection
'upgrade';` hardcoded unconditionally (a miscopied WebSocket snippet),
which broke nginx's ability to reuse connections to the Node upstream —
every request opened and tore down a fresh TCP connection. Under load-test
volume this produced instant `502`s; doubling pm2 instances alone made
failure rate *worse* (52%→78%) because more app capacity just meant more
churn against the same broken proxy layer. Fixed the same day in both
vhosts (`/etc/nginx/conf.d/websocket-upgrade-map.conf` + an `upstream {
keepalive 64; }` block per vhost). Combined, both fixes took a 1500-VU
staging test from 52% failure (broken nginx, 1 instance) to 2.68% failure,
zero `502`s, best throughput (fixed nginx, 2 instances). Full incident
writeup lives in the frontend repo's memory system as
`nginx-connection-upgrade-misconfig` and `pm2-single-instance-cron-guard`
(auto-memory, not in this repo — ask Claude/Codex in the frontend repo to
recall them if you need the full blow-by-blow).

**Not done**: the residual 2.68% failure at 2-instance/1500-VU scale
(mostly `401`s at 7.5%, unexplained — higher than the 1-instance run,
worth investigating; some `500`s) was not root-caused. Capacity numbers in
[[capacity-ceiling-load-test]] are stale on three counts now (droplet
vCPU upgrade, nginx fix, this pm2 change) — re-baseline before quoting any
DAU ceiling.
