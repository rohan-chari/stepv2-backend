const BATCH_SIZE = 128;
// Inbox is one of several concurrent launch reads. Serial database pages keep
// batching useful without allowing this endpoint to monopolize the HTTP pool.
const BATCH_CONCURRENCY = 1;
const {
  scheduleBoundedBatchDrain,
} = require("../../../shared/batching/boundedBatchDrain");

const FIRST_PAGES_SQL = `
  WITH requests AS (
    SELECT * FROM jsonb_to_recordset($1::jsonb)
      AS request("userId" text,"now" timestamptz,"limit" integer)
  )
  SELECT request."userId" AS "requestUserId",
         (SELECT COUNT(*) FROM inbox_alerts unread
           WHERE unread.user_id=request."userId" AND unread.read_at IS NULL
             AND unread.expires_at>request."now") AS "unreadCount",
         (SELECT COUNT(*) FROM feedback_threads thread
           WHERE thread.user_id=request."userId" AND thread.user_read_at IS NULL
             AND thread.expires_at>request."now") AS "supportUnreadCount",
         alert.id,alert.user_id AS "userId",alert.type,alert.destination,
         alert.title,alert.body,alert.source_key AS "sourceKey",
         alert.read_at AS "readAt",alert.created_at AS "createdAt",
         alert.expires_at AS "expiresAt"
    FROM requests request
    LEFT JOIN LATERAL (
      SELECT * FROM inbox_alerts candidate
       WHERE candidate.user_id=request."userId"
         AND candidate.expires_at>request."now"
       ORDER BY candidate.created_at DESC,candidate.id DESC
       LIMIT request."limit" + 1
    ) alert ON true
   ORDER BY request."userId",alert.created_at DESC,alert.id DESC`;

function createInboxFirstPageBatch() {
  const states = new WeakMap();
  function load({ prisma, userId, now, limit }) {
    let state = states.get(prisma);
    if (!state) {
      state = { pending: [], draining: false };
      states.set(prisma, state);
    }
    const promise = new Promise((resolve, reject) => {
      state.pending.push({ userId, now, limit, resolve, reject });
    });
    scheduleBoundedBatchDrain(state, async (pending) => {
          const pages = [];
          for (let offset = 0; offset < pending.length; offset += BATCH_SIZE) {
            pages.push(pending.slice(offset, offset + BATCH_SIZE));
          }
          let nextPage = 0;
          await Promise.all(Array.from(
            { length: Math.min(BATCH_CONCURRENCY, pages.length) },
            async () => {
            for (;;) {
              const index = nextPage++;
              if (index >= pages.length) return;
              const page = pages[index];
            const rows = await prisma.$queryRawUnsafe(
              FIRST_PAGES_SQL,
              JSON.stringify(page.map((request) => ({
                userId: request.userId,
                now: request.now.toISOString(),
                limit: request.limit,
              }))),
            );
            const alertIds = rows.map((row) => row.id).filter(Boolean);
            const outboxes = alertIds.length
              ? await prisma.inboxDeliveryOutbox.findMany({
                  where: { alertId: { in: alertIds } },
                  select: { alertId: true, kind: true, payload: true },
                })
              : [];
            const outboxByAlert = new Map();
            for (const outbox of outboxes) {
              const list = outboxByAlert.get(outbox.alertId) || [];
              list.push(outbox);
              outboxByAlert.set(outbox.alertId, list);
            }
            const grouped = new Map(page.map((request) => [request.userId, []]));
            const counts = new Map();
            for (const row of rows) {
              counts.set(row.requestUserId, {
                unreadCount: Number(row.unreadCount) || 0,
                supportUnreadCount: Number(row.supportUnreadCount) || 0,
              });
              if (row.id) grouped.get(row.requestUserId)?.push({
                id: row.id, userId: row.userId, type: row.type,
                destination: row.destination, title: row.title, body: row.body,
                sourceKey: row.sourceKey, readAt: row.readAt,
                createdAt: row.createdAt, expiresAt: row.expiresAt,
                outbox: outboxByAlert.get(row.id) || [],
              });
            }
            for (const request of page) {
              const count = counts.get(request.userId) || {
                unreadCount: 0, supportUnreadCount: 0,
              };
              request.resolve({
                rows: grouped.get(request.userId) || [],
                unreadCount: count.unreadCount,
                totalUnreadCount: count.unreadCount + count.supportUnreadCount,
              });
            }
            }
          }));
    });
    return promise;
  }
  return { load };
}

const inboxFirstPageBatch = createInboxFirstPageBatch();

module.exports = {
  BATCH_CONCURRENCY, BATCH_SIZE, FIRST_PAGES_SQL,
  createInboxFirstPageBatch, inboxFirstPageBatch,
};
