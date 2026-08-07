# Redis derived-data layer — operations runbook

Spec: `stepv2-frontend/docs/redis-derived-data-layer-requirements.md` (v10).
Everything here concerns the droplet `167.172.225.16`. The app DB is DO-managed
and has nothing to do with this Redis.

## Installed state (2026-08-07)

- `redis-server` (apt), enabled on boot, bound to `127.0.0.1` + `::1` only.
- Auth: `requirepass` — password in `/root/redis-rollout-baseline-2026-08-07.txt`
  (root-only, 0600), alongside the pg_stat baseline snapshot.
- `maxmemory 100mb`, `maxmemory-policy allkeys-lru`, RDB **and** AOF disabled
  (`save ""`, `appendonly no`) — pure disposable cache; a flush or restart
  costs only cold-cache latency, never data.
- Config backup: `/etc/redis/redis.conf.bak-20260807`.
- Env split: prod uses logical `db0` + key prefix `p:`; staging `db1` + `s:`.
  Pub/sub channels are prefix-namespaced (`p:cache:invalidate` /
  `s:cache:invalidate`) because pub/sub ignores logical DBs.

## Wiring (done at deploy time, NOT before)

Backend reads `REDIS_URL` and `CACHE_ENV_PREFIX` from `.env`:

```
REDIS_URL=redis://:<password>@127.0.0.1:6379/0   # staging: /1
CACHE_ENV_PREFIX=p:                               # staging: s:
```

Unset `REDIS_URL` ⇒ the wrapper is fully inert (no connection attempt).
Deploys use `pm2 reload` (NEVER `restart`; see backend deploy notes).

## Flags (app_settings rows, all default false)

| Flag | Surface |
|---|---|
| `redisCacheCatalogsEnabled` | C1 catalogs/config |
| `redisCacheMessagesEnabled` | C2 chat |
| `redisStandingsEnabled` | C3 standings snapshot + write-back removal |
| `redisCacheUserBitsEnabled` | C4 friends-steps + inventory |
| `redisCacheAuthMeEnabled` | C5 /auth/me (flip only after the invalidation inventory review) |
| `raceQueueV2ClaimingDisabled` | C0 rollback: stops v2 worker claims (read per tick, uncached) |
| `inlineRaceResolutionFallback` | C0 rollback: restores inline resolution on legacy paths |

## Kill switches, in escalating order

1. **One surface misbehaves** → flip its flag off (app_settings). Takes effect
   within the settings TTL (≤30s; immediate after C1's pub/sub is live).
2. **All caching suspect** → `redis-cli -a <pass> FLUSHDB` on the affected env's
   DB (cold cache, zero data loss), or flip all five cache flags.
3. **Redis itself suspect** → remove `REDIS_URL` from `.env` + `pm2 reload`.
   Every read falls back to Postgres paths (standings falls back to the CHEAP
   persisted read by design — race detail freshness degrades to worker cadence;
   that is expected, not a bug).
4. **C0 (queue) rollback** — ORDER MATTERS (spec §5a):
   a. Flip `raceQueueV2ClaimingDisabled = true` (v2 claims stop within a tick).
   b. Wait ≥30s; verify `SELECT count(*) FROM race_resolution_jobs_v2 WHERE
      status='RUNNING' AND lease_expires_at > now()` returns 0.
   c. Only then deploy the old binary. Never redeploy first — the old table's
      intact schema makes the old binary schema-safe, not concurrency-safe.
   Staying on the new binary with a sick worker: `inlineRaceResolutionFallback
   = true` restores inline resolution (worker kill switch alone freezes totals).

## Alarms / monitoring

- **Queue lag**: worker logs `max(now - requested_at)` per minute; investigate
  at >30s sustained. First response: raise `ASYNC_RACE_RESOLUTION_CONCURRENCY`.
- **Redis memory**: alarm at 75MB (`redis-cli INFO memory | grep used_memory_human`);
  expected working set <20MB.
- **"Races list disagrees with race detail"** user report → first check the
  worker/kill-switch state: with the worker down, `/progress` stays fresh while
  persisted surfaces stall (spec §7 scenario d) — divergence is the symptom of
  a stopped worker, not a cache bug.
- `/health` now reports `redis: ok|down|disabled`.

## Baselines (captured 2026-08-07, pre-rollout)

- `/root/redis-rollout-baseline-2026-08-07.txt`: pg_stat_database snapshot —
  deadlocks=2, xact_commit=97,950,482, `stats_reset` is NULL (lifetime
  counters — always compare as deltas from this snapshot).
- nginx `timed` log format live since 2026-08-07 16:42 ET (`rt=`/`urt=` fields
  in `/var/log/nginx/access.log`) — per-endpoint p50/p95 comes from ≥48h of
  this before any flag flips.
- Bot probes (`*.php`, `/wp-*`, `/xmlrpc.php`) on the API vhost → `return 444`,
  logged to `/var/log/nginx/access_bots.log`. Note: behind Cloudflare a 444
  surfaces to the scanner as a CF 520 — those 520s in CF analytics are the rule
  working, not an origin problem. Vhost backup:
  `/root/steptracker-api.org.bak-20260807`.

## Rollout order (owner-approved "faster" track)

1. Deploy backend with all flags off (both envs); wire `REDIS_URL` +
   `CACHE_ENV_PREFIX`; verify `/health` shows `redis: ok`.
2. C0 soaks on STAGING ALONE first (it is structural; don't share its soak
   window with cache flags). Exercise a full race lifecycle.
3. Then flip all five cache flags together on staging; soak ~24h including a
   purchase and a race settlement.
4. Prod: C0 deploy → observe → flip the five flags in one pass.
5. Regression response order: pull `redisStandingsEnabled` first (it's the only
   flag that *changes* behavior — write-back removal), then others to attribute.
6. Contract migration (drop old `race_resolution_jobs`) ≥1 week after expand,
   as its own deploy.
