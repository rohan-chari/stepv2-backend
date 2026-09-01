const {
  scheduleBoundedBatchDrain,
} = require("../../../shared/batching/boundedBatchDrain");
const { Prisma } = require("@prisma/client");

const BATCH_SIZE = 256;

function chunks(values) {
  const result = [];
  for (let offset = 0; offset < values.length; offset += BATCH_SIZE) {
    result.push(values.slice(offset, offset + BATCH_SIZE));
  }
  return result;
}

function createHomeLaunchAuxiliaryBatch() {
  const states = new WeakMap();
  function stateFor(prisma) {
    let state = states.get(prisma);
    if (!state) {
      state = {
        equipment: { pending: [], draining: false },
        milestones: { pending: [], draining: false },
        friendships: { pending: [], draining: false },
        inbox: { pending: [], draining: false },
        globalEventSummary: { pending: [], draining: false },
        capes: new Map(),
      };
      states.set(prisma, state);
    }
    return state;
  }

  function enqueue(prisma, name, request, drain) {
    const queue = stateFor(prisma)[name];
    const promise = new Promise((resolve, reject) => {
      queue.pending.push({ ...request, resolve, reject });
    });
    scheduleBoundedBatchDrain(queue, drain);
    return promise;
  }

  function loadEquipment({ prisma, userId }) {
    return enqueue(prisma, "equipment", { userId }, async (requests) => {
      for (const page of chunks(requests)) {
        const ids = [...new Set(page.map((request) => request.userId))];
        const rows = await prisma.userEquippedAccessory.findMany({
          where: { userId: { in: ids } },
          include: { shopItem: true },
        });
        const grouped = new Map(ids.map((id) => [id, []]));
        for (const row of rows || []) grouped.get(row.userId)?.push(row);
        for (const request of page) request.resolve(grouped.get(request.userId) || []);
      }
    });
  }

  function loadCape({ prisma, cacheKey, where, orderBy }) {
    const capes = stateFor(prisma).capes;
    const current = Date.now();
    const cached = capes.get(cacheKey);
    if (cached?.value !== undefined && cached.expiresAt > current) {
      return Promise.resolve(cached.value);
    }
    if (cached?.promise) return cached.promise;
    const promise = prisma.shopItem.findFirst({ where, orderBy }).then((value) => {
      capes.set(cacheKey, { value: value || null, expiresAt: Date.now() + 60_000 });
      return value || null;
    }).catch((error) => {
      capes.delete(cacheKey);
      throw error;
    });
    capes.set(cacheKey, { promise, expiresAt: 0 });
    return promise;
  }

  function loadMilestones({ prisma, userId, localDate }) {
    return enqueue(prisma, "milestones", { userId, localDate }, async (requests) => {
      for (const page of chunks(requests)) {
        const ids = [...new Set(page.map((request) => request.userId))];
        const localDates = [...new Set(page.map((request) => request.localDate))];
        const [steps, claims] = await Promise.all([
          prisma.step.findMany({
            where: {
              userId: { in: ids },
              date: { in: localDates.map((date) => new Date(date)) },
            },
          }),
          prisma.stepMilestoneClaim.findMany({
            where: { userId: { in: ids }, claimedDate: { in: localDates } },
            select: { userId: true, claimedDate: true, threshold: true },
          }),
        ]);
        const key = (id, date) => `${id}\u0000${date}`;
        const stepByKey = new Map((steps || []).map((row) => [
          key(row.userId, new Date(row.date).toISOString().slice(0, 10)), row,
        ]));
        const claimsByKey = new Map();
        for (const row of claims || []) {
          const rowKey = key(row.userId, row.claimedDate);
          if (!claimsByKey.has(rowKey)) claimsByKey.set(rowKey, []);
          claimsByKey.get(rowKey).push(row);
        }
        for (const request of page) {
          const requestKey = key(request.userId, request.localDate);
          request.resolve({
            stepRecord: stepByKey.get(requestKey) || null,
            claims: claimsByKey.get(requestKey) || [],
          });
        }
      }
    });
  }

  function loadFriendships({ prisma, userId, select }) {
    return enqueue(prisma, "friendships", { userId, select }, async (requests) => {
      for (const page of chunks(requests)) {
        const ids = [...new Set(page.map((request) => request.userId))];
        const rows = await prisma.friendship.findMany({
          where: {
            OR: [
              { requesterId: { in: ids }, status: { in: ["ACCEPTED", "PENDING"] } },
              { addresseeId: { in: ids }, status: { in: ["ACCEPTED", "PENDING"] } },
            ],
          },
          select: page[0].select,
        });
        for (const request of page) {
          request.resolve((rows || []).filter((row) =>
            row.requesterId === request.userId || row.addresseeId === request.userId));
        }
      }
    });
  }

  function loadInboxCounts({ prisma, userId, now }) {
    return enqueue(prisma, "inbox", { userId, now }, async (requests) => {
      for (const page of chunks(requests)) {
        const ids = [...new Set(page.map((request) => request.userId))];
        const oldest = new Date(Math.min(...page.map((request) => request.now.getTime())));
        const [alerts, threads] = await Promise.all([
          prisma.inboxAlert.findMany({
            where: { userId: { in: ids }, expiresAt: { gt: oldest }, readAt: null },
            select: { userId: true, expiresAt: true },
          }),
          prisma.feedbackThread.findMany({
            where: { userId: { in: ids }, expiresAt: { gt: oldest }, userReadAt: null },
            select: { userId: true, expiresAt: true },
          }),
        ]);
        for (const request of page) {
          request.resolve({
            unreadCount: (alerts || []).filter((row) =>
              row.userId === request.userId && new Date(row.expiresAt) > request.now).length,
            supportThreadUnreadCount: (threads || []).filter((row) =>
              row.userId === request.userId && new Date(row.expiresAt) > request.now).length,
          });
        }
      }
    });
  }

  function loadGlobalEventSummary({ prisma, userId }) {
    return enqueue(prisma, "globalEventSummary", { userId }, async (requests) => {
      for (const page of chunks(requests)) {
        const ids = [...new Set(page.map((request) => request.userId))];
        const rows = await prisma.$queryRaw(Prisma.sql`
          WITH authoritative_time AS (
            SELECT statement_timestamp() AT TIME ZONE 'UTC' AS now_at_load
          ), ranked AS (
            SELECT
              s.user_id AS "userId",
              s.id,
              s.event_id AS "eventId",
              s.extra_race_steps AS "extraRaceSteps",
              s.race_count AS "raceCount",
              s.settled_at AS "settledAt",
              s.expires_at AS "expiresAt",
              GREATEST(0,FLOOR(EXTRACT(EPOCH FROM
                (s.expires_at-t.now_at_load))*1000))::int AS "remainingMsAtLoad",
              ROW_NUMBER() OVER (
                PARTITION BY s.user_id ORDER BY s.settled_at DESC,s.id DESC
              )::int AS row_number
            FROM global_event_user_summaries s
            CROSS JOIN authoritative_time t
            WHERE s.user_id IN (${Prisma.join(ids)})
              AND s.acknowledged_at IS NULL
              AND s.attribution_version=2
              AND s.expires_at>t.now_at_load
              AND EXISTS (
                SELECT 1 FROM global_event_race_impacts i
                WHERE i.event_id=s.event_id AND i.user_id=s.user_id
                  AND i.status='FINAL' AND i.attribution_version=2
                  AND i.delta_steps<>0
              )
          )
          SELECT * FROM ranked WHERE row_number=1
        `);
        const byUserId = new Map();
        for (const row of rows || []) {
          if (!Number.isInteger(row.remainingMsAtLoad) || row.remainingMsAtLoad <= 0) continue;
          const { userId: ignoredUserId, remainingMsAtLoad, row_number: ignoredRank, ...summary } = row;
          void ignoredUserId;
          void ignoredRank;
          byUserId.set(row.userId, { ...summary, validForMs: remainingMsAtLoad });
        }
        for (const request of page) request.resolve(byUserId.get(request.userId) || null);
      }
    });
  }

  return {
    loadCape,
    loadEquipment,
    loadFriendships,
    loadGlobalEventSummary,
    loadInboxCounts,
    loadMilestones,
  };
}

const homeLaunchAuxiliaryBatch = createHomeLaunchAuxiliaryBatch();

module.exports = {
  BATCH_SIZE,
  createHomeLaunchAuxiliaryBatch,
  homeLaunchAuxiliaryBatch,
};
