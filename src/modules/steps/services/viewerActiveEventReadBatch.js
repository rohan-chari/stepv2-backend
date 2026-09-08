const BATCH_SIZE = 256;
const {
  scheduleBoundedBatchDrain,
} = require("../../../shared/batching/boundedBatchDrain");

// Keep each lookup anchored to one requested user's indexed entitlements.
// The lateral LIMIT bounds event selection; OFFSET 0 keeps the existence
// predicate correlated so PostgreSQL can stop at the first qualifying event
// instead of flattening it into a broad join and sorting all matches.
// The user-only membership gate skips event probes when no race can qualify.
const READ_SQL = `
WITH requested AS (
  SELECT * FROM jsonb_to_recordset($1::jsonb) AS request(
    "userId" text, "at" timestamptz
  )
)
SELECT DISTINCT ON (requested."userId")
  requested."userId", active.event_id AS "eventId",
  active.multiplier, active.ends_at AS "endsAt"
FROM requested
CROSS JOIN LATERAL (
  SELECT entitlement.event_id, event.multiplier,
         entitlement.ends_at, entitlement.starts_at
  FROM global_step_event_entitlements entitlement
  JOIN global_step_events event ON event.id=entitlement.event_id
    AND event.schedule_mode='LOCAL_ENTITLEMENTS'
  WHERE EXISTS (
      SELECT 1 FROM race_participants membership
      JOIN races membership_race ON membership_race.id=membership.race_id
        AND membership_race.status::text='active'
      WHERE membership.user_id=requested."userId"
        AND membership.status::text='accepted'
        AND membership.forfeited_at IS NULL AND membership.finished_at IS NULL
        AND ($2::text IS NULL OR membership.race_id=$2::text)
      OFFSET 0
    )
    AND entitlement.user_id=requested."userId"
    AND entitlement.starts_at <= requested."at"
    AND entitlement.ends_at > requested."at"
    AND entitlement.start_outcome IN ('ACTIVATED_ON_TIME','ACTIVATED_LATE_JOIN')
    AND EXISTS (
      SELECT 1 FROM global_event_race_impacts impact
      JOIN races race ON race.id=impact.race_id AND race.status::text='active'
      JOIN race_participants participant ON participant.race_id=impact.race_id
        AND participant.user_id=requested."userId"
        AND participant.status::text='accepted'
        AND participant.forfeited_at IS NULL AND participant.finished_at IS NULL
      WHERE impact.event_id=entitlement.event_id
        AND impact.user_id=requested."userId"
        AND ($2::text IS NULL OR impact.race_id=$2::text)
      OFFSET 0
    )
  ORDER BY entitlement.starts_at DESC
  LIMIT 1
) active
ORDER BY requested."userId",active.starts_at DESC`;

function createViewerActiveEventReadBatch() {
  const states = new WeakMap();

  function queueFor(prisma, raceId) {
    let byRace = states.get(prisma);
    if (!byRace) {
      byRace = new Map();
      states.set(prisma, byRace);
    }
    const key = raceId || "";
    let queue = byRace.get(key);
    if (!queue) {
      queue = { pending: [], draining: false };
      byRace.set(key, queue);
    }
    return queue;
  }

  function load({ prisma, userId, raceId = null, now = new Date() }) {
    const queue = queueFor(prisma, raceId);
    const promise = new Promise((resolve, reject) => {
      queue.pending.push({ userId, now, resolve, reject });
    });
    scheduleBoundedBatchDrain(queue, async (requests) => {
      for (let offset = 0; offset < requests.length; offset += BATCH_SIZE) {
        const page = requests.slice(offset, offset + BATCH_SIZE);
        const payload = page.map((request) => ({
          userId: request.userId,
          at: new Date(request.now).toISOString(),
        }));
        const rows = await prisma.$queryRawUnsafe(
          READ_SQL,
          JSON.stringify(payload),
          raceId,
        );
        const byUserId = new Map((rows || []).map((row) => [row.userId, {
          eventId: row.eventId,
          multiplier: Number(row.multiplier),
          endsAt: row.endsAt,
        }]));
        for (const request of page) {
          request.resolve(byUserId.get(request.userId) || null);
        }
      }
    });
    return promise;
  }

  return { load };
}

const viewerActiveEventReadBatch = createViewerActiveEventReadBatch();

module.exports = {
  BATCH_SIZE,
  READ_SQL,
  createViewerActiveEventReadBatch,
  viewerActiveEventReadBatch,
};
