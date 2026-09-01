const BATCH_SIZE = 256;
const {
  scheduleBoundedBatchDrain,
} = require("../../../shared/batching/boundedBatchDrain");

const READ_SQL = `
  WITH requested AS (
    SELECT * FROM jsonb_to_recordset($1::jsonb) AS request(
      "userId" text,
      "at" timestamptz
    )
  )
  SELECT DISTINCT ON (requested."userId")
         requested."userId",
         entitlement.event_id AS "eventId",
         event.multiplier,
         entitlement.ends_at AS "endsAt"
    FROM requested
    JOIN global_step_event_entitlements entitlement
      ON entitlement.user_id=requested."userId"
     AND entitlement.starts_at <= requested."at"
     AND entitlement.ends_at > requested."at"
     AND entitlement.start_outcome IN ('ACTIVATED_ON_TIME','ACTIVATED_LATE_JOIN')
    JOIN global_step_events event
      ON event.id=entitlement.event_id
     AND event.schedule_mode='LOCAL_ENTITLEMENTS'
    JOIN global_event_race_impacts impact
      ON impact.event_id=entitlement.event_id
     AND impact.user_id=requested."userId"
     AND ($2::text IS NULL OR impact.race_id=$2::text)
    JOIN races race
      ON race.id=impact.race_id
     AND race.status::text='active'
    JOIN race_participants participant
      ON participant.race_id=impact.race_id
     AND participant.user_id=requested."userId"
     AND participant.status::text='accepted'
     AND participant.forfeited_at IS NULL
     AND participant.finished_at IS NULL
   ORDER BY requested."userId",entitlement.starts_at DESC`;

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
