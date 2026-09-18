# Bara Post-Deploy Checklist

Run this checklist immediately after
`./scripts/pm2-safe-prod-reload.sh` completes. HTTP health alone is not a
successful deployment.

The operator may use SSH/read-only production inspection. Do not print secrets.

## Phase 1 — Verify exact artifact

```bash
cd /var/www/step-tracker-backend
git rev-parse HEAD
git status --short
```

- [ ] HEAD equals the authorized production commit.
- [ ] no unexpected local modifications.

## Phase 2 — Verify PM2 topology

```bash
pm2 list
npm run pm2:topology:check
```

Expected:

```text
steps-tracker                 online x2
steps-tracker-step            online x1
steps-tracker-resolution      online x1
steps-tracker-event           online x1
steps-tracker-notification    online x1
steps-tracker-cron            online x1
steps-tracker-staging         stopped
```

Expected identities:

```text
http:0
http:1
step:0
resolution:0
event:0
notification:0
cron:0
```

STOP / rollback investigation if:

- a required process is missing;
- an unexpected production process exists;
- restart counts begin climbing;
- the topology guard fails;
- an orphaned production Node process is found.

## Phase 3 — Verify DB pool startup configuration

Read fresh startup records:

```bash
for app in   steps-tracker   steps-tracker-step   steps-tracker-resolution   steps-tracker-event   steps-tracker-notification   steps-tracker-cron
do
  pm2 logs "$app" --lines 200 --nostream |     grep '"event":"database_pool_configuration_v1"' || true
done
```

Expected:

```text
http:0            10
http:1            10
step:0             3
resolution:0       6
event:0            3
notification:0     4
cron:0             3
aggregate          39
```

Any role using a fallback/default instead of its exact production variable is a
STOP condition.

## Phase 4 — Verify HTTP health

```bash
curl -fsS localhost:3002/health
curl -fsS https://steptracker-api.org/health
```

Both must succeed.

Also verify the marketing/static surfaces when the deploy changes web output:

```bash
curl -fsSI https://barastep.com/ | head -1
curl -fsSI https://barastep.com/privacy | head -1
curl -fsSI https://barastep.com/support | head -1
```

## Phase 5 — Verify queue Redis

```bash
npm run queues:health
```

The command reports for all five streams:

- stream length;
- consumer group;
- consumer count;
- pending count;
- waiting/lag count;
- oldest pending age.

Expected ownership:

| Queue | Required live owner |
| --- | --- |
| STEP_SYNC | `steps-tracker-step` |
| POWERUP_RECALC | `steps-tracker-resolution` |
| RACE_DIRTY | `steps-tracker-resolution` |
| GLOBAL_EVENT_BOUNDARY | `steps-tracker-event` |
| NOTIFICATION_DELIVERY | `steps-tracker-notification` |

All five must have at least one consumer.

A temporary backlog during the handoff is acceptable. A monotonically growing
backlog or pending age is not.

## Phase 6 — Verify queue Redis persistence/memory

Using the dedicated queue Redis port:

```bash
redis-cli -p <queue-port> INFO memory
redis-cli -p <queue-port> INFO persistence
redis-cli -p <queue-port> INFO stats
redis-cli -p <queue-port> CONFIG GET maxmemory
redis-cli -p <queue-port> CONFIG GET maxmemory-policy
redis-cli -p <queue-port> CONFIG GET appendonly
redis-cli -p <queue-port> CONFIG GET appendfsync
```

Verify:

- [ ] `noeviction`;
- [ ] AOF enabled;
- [ ] reviewed fsync policy;
- [ ] no AOF errors;
- [ ] no rejected writes from memory exhaustion;
- [ ] RSS/maxmemory appropriate for the 4-GB host.

## Phase 7 — Verify stream trimming

Cron owns `scheduleRedisStreamTrimmer`.

Check fresh cron logs for trimmer errors and compare stream lengths across the
observation window.

GO behavior:

- stream history stays bounded when consumers are healthy;
- unread work is retained;
- pending work is retained;
- memory does not grow without bound.

Any evidence that pending/unread work is being trimmed is an immediate STOP.

## Phase 8 — PostgreSQL connection/pressure check

```sql
SELECT application_name, state, count(*)
FROM pg_stat_activity
WHERE datname = current_database()
GROUP BY 1,2
ORDER BY 1,2;

SELECT pid, application_name, state,
       now() - xact_start AS transaction_age,
       wait_event_type, wait_event
FROM pg_stat_activity
WHERE datname = current_database()
  AND xact_start IS NOT NULL
ORDER BY xact_start;
```

Verify application names exist for all expected roles.

Check:

- total sessions;
- waiting sessions;
- long-running transactions;
- deadlocks;
- pool wait telemetry;
- connection failures;
- managed DB CPU.

Steady application pools are capped at 39. The database having a larger
connection ceiling is not permission to increase them during incident response.

## Phase 9 — Host memory/CPU/swap check

This is mandatory because the 2-vCPU / 4-GB host now runs more isolated Node
processes plus a second Redis.

```bash
free -h
swapon --show
uptime
pm2 list
ps -eo pid,ppid,%cpu,%mem,rss,cmd --sort=-rss | head -30
```

Compare with the pre-deploy baseline.

Watch for:

- sustained swap growth;
- low available memory;
- OOM/restart behavior;
- one new worker consuming unexpectedly large RSS;
- sustained CPU saturation.

Do not “fix” memory pressure by increasing worker counts.

## Phase 10 — Fresh error scan

Inspect each app separately:

```bash
for app in   steps-tracker   steps-tracker-step   steps-tracker-resolution   steps-tracker-event   steps-tracker-notification   steps-tracker-cron
do
  echo "===== $app ====="
  pm2 logs "$app" --lines 500 --nostream |     grep -iE 'QUEUE_REDIS_UNAVAILABLE|redisStreams|worker loop failed|P2024|P2028|TooManyConnections|deadlock|notification backlog alert|delivery failed|unhandled|fatal|out of memory' || true
done
```

Investigate every new/repeating error. Do not dismiss it because `/health`
passes.

## Phase 11 — Functional queue smoke

Exercise at least one real safe flow through each relevant queue.

### Step/race pipeline

- [ ] trigger a normal step sync;
- [ ] API returns expected queue-first response;
- [ ] STEP_SYNC backlog drains;
- [ ] race total eventually reflects the sync;
- [ ] POWERUP_RECALC/RACE_DIRTY processing converges;
- [ ] mystery-box progression remains correct when applicable.

### Powerup/race resolution

- [ ] use a safe test powerup/race flow;
- [ ] resulting race state converges;
- [ ] no duplicate resolution/effect behavior.

### Notification

- [ ] create a safe notification-producing flow;
- [ ] domain event projects;
- [ ] schedule/inbox state materializes;
- [ ] notification stream drains;
- [ ] push/inbox result appears as expected.

### Global event

- [ ] event schedule/boundary consumer is alive;
- [ ] no duplicate boundary processing;
- [ ] event state converges.

### Settlement

- [ ] a safe race completion/settlement path remains healthy.

Use designated test/admin accounts. Do not manufacture destructive production
data merely to satisfy a smoke checkbox.

## Phase 12 — Immediate 5-minute observation

For at least five minutes after deployment:

- [ ] all PM2 processes remain online;
- [ ] restart counts stable;
- [ ] queue lag drains or stays near zero;
- [ ] pending age does not grow;
- [ ] queue Redis memory stable;
- [ ] no AOF errors;
- [ ] DB connections remain bounded;
- [ ] DB CPU does not show a new sustained regression;
- [ ] host available RAM remains healthy;
- [ ] swap is not rapidly increasing;
- [ ] no repeating new errors.

## Phase 13 — 30–60 minute stabilization

Continue observing:

```bash
npm run queues:health
pm2 list
free -h
```

Re-run the DB session census.

Compare to the pre-deploy baseline.

GO criteria:

- queue lag is not monotonically increasing;
- queue Redis memory is stable;
- process RSS is stable;
- restart counts are stable;
- DB pool waits are acceptable;
- database CPU is reasonable for traffic;
- notification backlog is healthy;
- no deadlocks/transaction timeout pattern.

## Phase 14 — Daily 2x event checkpoint

Because this release specifically changes/scales the daily 2x event path, the
deploy is not fully validated until at least one real boundary is observed.

During the next daily 2x event:

- [ ] event scheduler fires once;
- [ ] GLOBAL_EVENT_BOUNDARY stream drains;
- [ ] no duplicated start/end effects;
- [ ] DB CPU spike is materially controlled versus prior behavior;
- [ ] notification delivery backlog drains;
- [ ] race resolution backlog does not run away;
- [ ] queue Redis memory remains healthy;
- [ ] no worker restart/deadlock spike.

Record the observation.

## Phase 15 — Deployment completion report

Report:

```text
deployed commit:
PM2 topology:
DB pool aggregate:
queue Redis memory/persistence:
queue health:
DB sessions/CPU:
host RAM/swap:
5-minute observation:
30-60 minute observation:
2x event checkpoint:
new errors:
remaining follow-ups:
DEPLOYMENT COMPLETE / HOLD / ROLLBACK:
```

Do not call the deployment complete while a required observation is still
failing. The 2x checkpoint may be marked “pending observation” after the
immediate deployment window, but it must remain an explicit follow-up rather
than being forgotten.
