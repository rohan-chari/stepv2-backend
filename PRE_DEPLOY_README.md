# Bara Pre-Deploy Checklist

This is the mandatory pre-deploy checklist for the queue-first scalability
release and the baseline for future backend production deployments.

**Do not deploy to production unless the user gives explicit, in-the-moment
authorization after this checklist is complete.**

The operator/agent may use SSH and read production state while completing this
checklist. Do not print secrets, database passwords, Redis URLs, private keys, or
tokens into chat/log artifacts.

## Target production topology

The reviewed split topology is:

| PM2 app | Count | Role | DB pool |
| --- | ---: | --- | ---: |
| `steps-tracker` | 2 | `http` | 10 each |
| `steps-tracker-step` | 1 | `step` | 3 |
| `steps-tracker-resolution` | 1 | `resolution` | 6 |
| `steps-tracker-event` | 1 | `event` | 3 |
| `steps-tracker-notification` | 1 | `notification` | 4 |
| `steps-tracker-cron` | 1 | `cron` | 3 |

Reviewed steady-state database pool aggregate: **39**.

The current managed PostgreSQL service is believed to allow roughly 96
connections. Verify the real control-plane value before deploy. The pool budget
remains 39 even when 96 is confirmed: CPU, memory, lock contention and query
throughput matter more than consuming the maximum available connection count.

A rolling HTTP replacement can briefly add one extra 10-connection HTTP pool,
so the reviewed worst-case application ceiling during a target-to-target reload
is approximately **49**, before maintenance/migration connections. Abort if the
actual database/pooler ceiling does not leave substantial headroom above this.

## Phase 0 — Code/release gate

- [ ] Exact candidate commit recorded.
- [ ] Branch is not behind `main`.
- [ ] Unit suite green.
- [ ] Integration suite green.
- [ ] Contract suite green.
- [ ] Reliability suite green.
- [ ] Performance suite green for this scalability release.
- [ ] HTTP/service suite green.
- [ ] Maintenance suite green.
- [ ] Final migration review complete.
- [ ] Final diff review complete.
- [ ] `OPERATIONS.md`, this file, and `POST_DEPLOY_README.md` match the code.

STOP if any required suite has an unexplained candidate regression.

## Phase 1 — Capture production baseline

SSH to the production host using the existing approved key configuration.

Record without exposing secrets:

```bash
date -u
uname -a
nproc
free -h
swapon --show
df -h
pm2 list
```

Capture current process RSS/restarts:

```bash
pm2 jlist | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const rows=JSON.parse(s).map(p=>({
    name:p.name,pid:p.pid,status:p.pm2_env?.status,
    restarts:p.pm2_env?.restart_time,memory:p.monit?.memory,
    cpu:p.monit?.cpu
  }));
  console.log(JSON.stringify(rows,null,2));
})'
```

Record:

- [ ] CPU count = expected 2 vCPU.
- [ ] RAM = expected ~4 GB.
- [ ] swap size/usage.
- [ ] filesystem free space.
- [ ] current PM2 topology.
- [ ] current restart counts.
- [ ] current HTTP/background RSS.
- [ ] existing cache Redis RSS.
- [ ] current load average.

Because this release adds three background Node processes plus a second Redis
instance, STOP if projected steady-state memory leaves inadequate OS/Postgres
client headroom or if swap is already under sustained pressure.

## Phase 2 — Verify PostgreSQL capacity

From the DigitalOcean control plane, record:

- [ ] database plan;
- [ ] direct connection maximum;
- [ ] managed-pool/pooler mode;
- [ ] pool size;
- [ ] reserved connections/headroom;
- [ ] current CPU and memory pressure.

Do not infer the managed-pool ceiling only from SQL.

Read-only SQL census:

```sql
SELECT application_name, state, count(*)
FROM pg_stat_activity
WHERE datname = current_database()
GROUP BY 1,2
ORDER BY 1,2;

SELECT count(*) AS total_sessions
FROM pg_stat_activity;

SHOW max_connections;
SHOW superuser_reserved_connections;
```

GO criteria:

- [ ] reviewed steady-state application budget 39 fits safely;
- [ ] transient reviewed application ceiling ~49 fits safely;
- [ ] migration/maintenance connections still have reserve;
- [ ] current DB is not already connection-starved.

Do **not** raise application pools merely because the database permits ~96
connections. More concurrent DB work can reduce throughput on a 2-vCPU workload.

## Phase 3 — Provision dedicated queue Redis on the droplet

This release deliberately keeps queue Redis on the existing production droplet.
Horizontal failover is a future scaling goal.

The queue Redis must be a **separate Redis server process**, not another logical
DB on the ordinary cache Redis.

First inspect existing Redis:

```bash
redis-cli -p 6379 INFO server | head
redis-cli -p 6379 INFO memory
redis-cli -p 6379 CONFIG GET maxmemory
redis-cli -p 6379 CONFIG GET maxmemory-policy
ss -ltnp | grep redis || true
systemctl list-units --type=service | grep -i redis || true
```

Provision a second instance with all of these properties:

- [ ] localhost-only bind;
- [ ] dedicated unused port (recommended `6380` after verifying it is free);
- [ ] dedicated config file;
- [ ] dedicated data directory;
- [ ] dedicated PID/log location as appropriate for the distro package;
- [ ] AOF persistence enabled;
- [ ] reviewed fsync policy;
- [ ] `maxmemory-policy noeviction`;
- [ ] explicit memory ceiling appropriate for the 4-GB host;
- [ ] automatic start on reboot;
- [ ] ordinary cache Redis config/state unchanged.

### Durability policy

Queue Redis receives work that may already have been acknowledged to a client.
Prefer:

```text
appendonly yes
appendfsync always
maxmemory-policy noeviction
```

If `appendfsync always` causes unacceptable measured intake latency, changing
to `everysec` requires an explicit review because it accepts up to roughly one
second of host-crash data-loss exposure.

Do not use an eviction policy for queue data. An exhausted queue should fail
visibly rather than silently delete accepted work.

### Memory ceiling

Do not choose a Redis memory ceiling from the 96-connection DB number.

For the 4-GB droplet:

1. record current steady-state Node + cache Redis + OS RSS;
2. reserve meaningful free/swap headroom;
3. select a bounded queue Redis ceiling;
4. record the chosen value in the deploy notes.

A reasonable initial target to evaluate is 256 MB, but the operator must verify
it against the actual baseline and expected queue backlog. Do not increase above
512 MB on this host without explicit review.

After provisioning:

```bash
redis-cli -p <queue-port> PING
redis-cli -p <queue-port> INFO persistence
redis-cli -p <queue-port> INFO memory
redis-cli -p <queue-port> CONFIG GET appendonly
redis-cli -p <queue-port> CONFIG GET appendfsync
redis-cli -p <queue-port> CONFIG GET maxmemory
redis-cli -p <queue-port> CONFIG GET maxmemory-policy
```

Expected:

- `PONG`
- AOF enabled
- reviewed fsync mode
- `noeviction`
- explicit maxmemory
- healthy persistence status

### Persistence restart proof

Before production uses the queue:

1. write a unique canary key to the queue Redis;
2. force/verify AOF state;
3. restart **only the queue Redis** through its system service;
4. confirm the canary still exists;
5. delete the canary.

Do not restart the ordinary cache Redis during this proof.

## Phase 4 — Configure `QUEUE_REDIS_URL`

Set `QUEUE_REDIS_URL` in the production environment to the dedicated local
queue Redis instance. Do not print its full value.

Verify only presence/target identity:

```bash
node - <<'NODE'
require("dotenv").config();
const value = process.env.QUEUE_REDIS_URL;
if (!value) throw new Error("QUEUE_REDIS_URL missing");
const url = new URL(value);
console.log({ configured: true, host: url.hostname, port: url.port || "6379" });
NODE
```

GO criteria:

- [ ] URL points to the dedicated queue Redis, not cache Redis.
- [ ] queue Redis is reachable.
- [ ] URL is not committed to git.
- [ ] no secret printed.

## Phase 5 — Initialize queue streams/groups

Run:

```bash
npm run queues:preflight
```

It must safely initialize/verify exactly:

| Queue | Stream | Group |
| --- | --- | --- |
| STEP_SYNC | `queue:step-sync:v1` | `step-workers-v1` |
| POWERUP_RECALC | `queue:powerup-recalc:v1` | `powerup-workers-v1` |
| RACE_DIRTY | `queue:race-dirty:v1` | `race-workers-v1` |
| GLOBAL_EVENT_BOUNDARY | `queue:global-event-boundary:v1` | `global-event-boundary-workers-v1` |
| NOTIFICATION_DELIVERY | `queue:notification-delivery:v1` | `notification-workers-v1` |

This command must not inject fake production work.

STOP if any group cannot be created/read.

## Phase 6 — Verify production pool configuration

Expected variables:

```text
DATABASE_POOL_MAX_HTTP=10
DATABASE_POOL_MAX_STEP=3
DATABASE_POOL_MAX_RESOLUTION=6
DATABASE_POOL_MAX_EVENT=3
DATABASE_POOL_MAX_NOTIFICATION=4
DATABASE_POOL_MAX_CRON=3
DATABASE_POOL_TOTAL_BUDGET=39
```

Run static validation from the candidate checkout:

```bash
npm run pm2:topology:check -- --pool-budget-mode=static
```

Expected target identities:

```text
http:0
http:1
step:0
resolution:0
event:0
notification:0
cron:0
```

The first rollout may still be running the reviewed legacy source topology:

```text
http:0
http:1
resolution:0
cron:0
```

Verify it is exactly legacy or exactly target:

```bash
node scripts/pm2-topology-guard.js --source-topology
```

STOP on any partial/unexpected topology.

## Phase 7 — Production database backup

This release changes schema/process/queue ownership, so take a dated production
backup.

Follow `OPERATIONS.md#production-database-backup`.

Required evidence:

- [ ] PostgreSQL 18+ dump client.
- [ ] production DB identity checked.
- [ ] dump created outside repo.
- [ ] `pg_restore -l` succeeds.
- [ ] dump copied to `/root/backups/`.
- [ ] local/remote SHA-256 match.
- [ ] local PII-bearing dump deleted in the same session.
- [ ] remote backup filename + checksum recorded.

STOP if checksum verification fails.

## Phase 8 — Migration preflight

Run:

```bash
node scripts/check-prod-migrations.js
npx prisma migrate status
```

Before deploy:

- [ ] enumerate every pending migration;
- [ ] inspect every pending SQL file;
- [ ] identify any `CREATE INDEX CONCURRENTLY` / extension special procedure;
- [ ] confirm no unexplained destructive DROP;
- [ ] confirm currently running code tolerates additive schema changes;
- [ ] confirm no failed migration ledger entry blocks deploy.

STOP on an unexplained migration.

## Phase 9 — Rollback readiness before deployment

Record:

- [ ] exact previous production commit/tag;
- [ ] exact candidate commit;
- [ ] production backup filename/checksum;
- [ ] source topology;
- [ ] target topology;
- [ ] queue Redis service/config/data paths;
- [ ] current queue health;
- [ ] rollback operator command path: `./scripts/pm2-safe-prod-reload.sh`.

### Resolution compatibility drain

If rolling back to an artifact that predates
`effectExpiryParticipantSteps` post-task support, old code must not consume
new-format work.

Before restoring such an artifact:

1. disable new core claims with the existing reviewed
   `raceQueueV2ClaimingDisabled` deployment-protocol control;
2. wait at least 65 seconds so any pre-disable JavaScript attempt has exceeded
   the 60-second fail-stop watchdog;
3. verify no active core lease remains;
4. keep the current binary online until all queued/running post-tasks whose
   `snapshot_command` contains `effectExpiryParticipantSteps` are drained;
5. re-check both counts immediately before checkout;
6. only then restore the prior code and run the guarded PM2 wrapper;
7. re-enable core claims after topology/health verification.

Any nonzero final count is a rollback **STOP** condition.

Do not drop additive schema or destroy queue Redis as part of application
rollback.

## Phase 10 — Final GO / NO-GO packet

Before requesting production deploy authorization, report:

```text
candidate commit:
source topology:
target topology:
queue Redis:
  port:
  persistence:
  fsync:
  maxmemory:
  eviction:
Postgres:
  verified connection ceiling:
  reviewed steady budget: 39
  reviewed transient app ceiling: ~49
backup:
  filename:
  checksum:
pending migrations:
queue preflight:
static PM2/pool preflight:
current host RAM/swap headroom:
GO / NO-GO:
```

Do not begin deployment until every required field is known and the user
explicitly authorizes production deployment.
