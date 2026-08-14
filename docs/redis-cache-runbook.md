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
| `apiRaceChatWatermarkCacheV1Enabled` | Body-free lazy-Chat USER watermark (`v1:race:msgwatermark:{raceId}:USER`); enable with message-streams |
| `redisStandingsEnabled` | C3 standings snapshot + write-back removal |
| `redisCacheUserBitsEnabled` | C4 friends-steps + inventory |
| `redisCacheAuthMeEnabled` | C5 /auth/me (flip only after the invalidation inventory review) |
| `raceQueueV2ClaimingDisabled` | C0 rollback: stops v2 worker claims (read per tick, uncached) |
| `inlineRaceResolutionFallback` | C0 rollback: restores inline resolution on legacy paths |
| `raceResolutionDisplayArtifactReuseV1Enabled` | Single-use 120s display artifact (`v1:race:resolution-artifact:{opaqueArtifactId}`); enable last after scorer-token baseline proof |

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

## Social-read caches (generation-guarded rollout)

The four social-read flags also default false:

| Flag | Surface |
|---|---|
| `redisPresentationGenerationGuardEnabled` | prerequisite for guarded presentation/topology readers |
| `redisCacheFriendsEnabled` | raw friendship topology behind `GET /friends` |
| `redisCacheLeaderboardEnabled` | raw step-ranking cores only |
| `redisFriendSearchRateLimitEnabled` | modern friend-search fixed-window counter |

Deploy Phase A with all four false. New workers advance topology/presentation
generation markers after commits even while readers remain legacy. Do not
enable the generation guard until telemetry proves every old DEL-only worker
has drained. Then enable the guard, wait through app-setting propagation, and
verify every worker reports guarded mode before enabling friends or leaderboard.
The search counter is independent. On staging, enable friends, leaderboard, and
search separately, exercise mutations between flips, and soak together for 24h.

Normal rollback disables only the affected surface. Before rolling back to a
binary with DEL-only invalidators: disable friends and leaderboard, wait for
propagation and in-flight reads to drain, disable the generation guard, verify
legacy-reader mode, then roll back the binary. Disable search too when returning
to a binary that lacks its counter.

Search throttling is availability-first and best-effort. A mid-minute flag or
mixed-worker transition can split allowances between Redis and Postgres (up to
30 on each while both retain state). A lost Redis reply can also consume Redis
and then fall back to Postgres. Redis eviction/restart resets its side; repeated
resets therefore have no strict per-minute upper bound. Search visibility and
authorization never depend on Redis, and search terms/results are never cached.

Before rollout, record endpoint `rt`/`urt` p50/p95 and volume, Postgres query
counts/plans on production-like staging, Redis memory/hits/key count, and verify
both partial friend-search GIN indexes are valid, ready, and used by the exact
predicates. Pin `LEADERBOARD_CACHE_WAIT_MS` to
`clamp(ceil(1.5 × measured cold-loader p95), 250ms, 5s)` and the lock lease to
`max(10s, ceil(5 × p95))`; record both measured values here before production.
