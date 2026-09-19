# Terminal race-stream failures

A terminal race failure is not successful scoring. The scheduler acknowledges its
Redis message only after re-reading an existing `FAILED` race job with a completion
timestamp and a generation at least as new as the message's persisted work.

The job ID, error, and pending/processing scopes stay unchanged in
`race_resolution_jobs_v2`. The scheduler logs `race_stream_terminal_failure_v1`
with the job ID, race ID, generation, and error code. This lets old stream history
be trimmed without deleting the database recovery record. Transient failures,
unconfirmed terminal states, and failed Redis acknowledgments remain retryable.

No automatic email or unlimited retry is added. Monitor the structured failure
log and the database failed-job count separately from queue depth. An empty Redis
pending list does not mean every race was scored successfully.

## Inspect and recover

The existing terminal-job retention defaults to 14 days. Investigate before that
retention expires; this change does not retain failed jobs forever. Inspect the
error and race state, and correct the underlying problem before requeueing.

```sql
SELECT id, race_id, generation, attempts, last_error_code, completed_at
FROM race_resolution_jobs_v2
WHERE state = 'failed'
ORDER BY completed_at, id
LIMIT 50;
```

From the deployed backend directory, retry one reviewed job by its exact ID:

```bash
RACE_JOB_ID='<failed-job-id>' node <<'NODE'
require('dotenv').config();
const { prisma } = require('./src/db');
const { publish, STREAMS, close } = require('./src/shared/queues/redisStreams');

async function main() {
  const id = process.env.RACE_JOB_ID;
  if (!id || id === '<failed-job-id>') throw new Error('Set RACE_JOB_ID to the reviewed job ID');
  // Retain both scope sets and the generation. claimNext merges pending and
  // processing scope so a failed attempt's work is not lost on this retry.
  const [job] = await prisma.$queryRawUnsafe(`
    UPDATE race_resolution_jobs_v2
       SET state='queued', attempts=0, retry_at=NULL, not_before_at=NULL,
           completed_at=NULL, lease_expires_at=NULL, lease_token=NULL,
           updated_at=clock_timestamp()
     WHERE id=$1 AND state='failed'
     RETURNING race_id AS "raceId", generation`, id);
  if (!job) throw new Error('No failed job matched; nothing was changed');
  await publish(STREAMS.RACE_DIRTY, {
    schemaVersion: 1, raceId: job.raceId,
    jobGeneration: Number(job.generation), reason: 'RECOVERY',
    requestedAt: new Date().toISOString(),
  });
  console.log('Recovery requested; verify the job reaches SUCCEEDED:', id);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
}).finally(async () => {
  await close().catch(() => {});
  await prisma.$disconnect();
});
NODE
```

This is an operator-triggered retry through the same Redis consumer and canonical
scoring engine, not a second scoring path. The SQL commits before publishing. If
the publish fails, the existing bounded database recovery sweep can discover the
now-queued job. Verify the resulting job state and actual race outcome; publishing
a wake is not evidence of successful scoring.

Do not clear dirty/processing scope, delete the failed job, flush the stream, or
mark a failure as `succeeded` to make queue health look clean.
