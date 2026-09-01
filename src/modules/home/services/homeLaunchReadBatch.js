const BATCH_SIZE = 256;
const { Prisma } = require("@prisma/client");
const {
  scheduleBoundedBatchDrain,
} = require("../../../shared/batching/boundedBatchDrain");
const { prisma: defaultPrisma } = require("../../../db");
const defaultPresentationCache = require("../../social/services/userPresentationCache");

function chunks(values) {
  const result = [];
  for (let offset = 0; offset < values.length; offset += BATCH_SIZE) {
    result.push(values.slice(offset, offset + BATCH_SIZE));
  }
  return result;
}

function createHomeLaunchReadBatch({
  presentationCache = defaultPresentationCache,
  defaultPrismaClient = defaultPrisma,
} = {}) {
  const states = new WeakMap();
  function stateFor(prisma) {
    let state = states.get(prisma);
    if (!state) {
      state = {
        pending: { pending: [], draining: false },
        activeIndividual: { pending: [], draining: false },
        activeTeam: { pending: [], draining: false },
        legacyActiveIndividual: { pending: [], draining: false },
        legacyActiveTeam: { pending: [], draining: false },
        acceptedRosters: { pending: [], draining: false },
        topAcceptedRosters: { pending: [], draining: false },
        boundedLegacyRosters: { pending: [], draining: false },
        users: { pending: [], draining: false },
      };
      states.set(prisma, state);
    }
    return state;
  }

  function loadLegacyActiveRow({ prisma, userId, supportsTeamRaces }) {
    const queue = supportsTeamRaces
      ? stateFor(prisma).legacyActiveTeam
      : stateFor(prisma).legacyActiveIndividual;
    const promise = new Promise((resolve, reject) => {
      queue.pending.push({ userId, supportsTeamRaces, resolve, reject });
    });
    scheduleBoundedBatchDrain(queue, async (requests) => {
      for (const page of chunks(requests)) {
        const ids = [...new Set(page.map((request) => request.userId))];
        const rows = await prisma.raceParticipant.findMany({
          where: {
            userId: { in: ids },
            status: "ACCEPTED",
            race: {
              status: "ACTIVE",
              tournamentId: null,
              ...(page[0].supportsTeamRaces ? {} : { isTeamRace: false }),
            },
          },
          include: { race: true },
          orderBy: { race: { startedAt: "desc" } },
        });
        const firstByUserId = new Map();
        for (const row of rows || []) {
          if (!firstByUserId.has(row.userId)) firstByUserId.set(row.userId, row);
        }
        for (const request of page) {
          request.resolve(firstByUserId.get(request.userId) || null);
        }
      }
    });
    return promise;
  }

  function loadAcceptedRoster({ prisma, raceId, participantSelect }) {
    const queue = stateFor(prisma).acceptedRosters;
    const promise = new Promise((resolve, reject) => {
      queue.pending.push({ raceId, participantSelect, resolve, reject });
    });
    scheduleBoundedBatchDrain(queue, async (requests) => {
      const raceIds = [...new Set(requests.map((request) => request.raceId))];
      const grouped = new Map(raceIds.map((id) => [id, []]));
      for (const page of chunks(raceIds)) {
        const rows = await prisma.raceParticipant.findMany({
          where: { raceId: { in: page }, status: "ACCEPTED" },
          select: { ...requests[0].participantSelect, raceId: true },
          orderBy: [{ raceId: "asc" }, { totalSteps: "desc" }],
        });
        for (const row of rows || []) grouped.get(row.raceId)?.push(row);
      }
      for (const request of requests) {
        request.resolve(grouped.get(request.raceId) || []);
      }
    });
    return promise;
  }

  function loadTopAcceptedRoster({ prisma, raceId, participantSelect }) {
    const queue = stateFor(prisma).topAcceptedRosters;
    const promise = new Promise((resolve, reject) => {
      queue.pending.push({ raceId, participantSelect, resolve, reject });
    });
    scheduleBoundedBatchDrain(queue, async (requests) => {
      const raceIds = [...new Set(requests.map((request) => request.raceId))];
      const byRaceId = new Map();
      // A launch wave normally shares one event race. Keep the reads bounded
      // per distinct race because Prisma cannot express top-N per relation,
      // and never hydrate the remaining thousands of participants.
      for (const raceId of raceIds) {
        const rows = await prisma.raceParticipant.findMany({
          where: { raceId, status: "ACCEPTED" },
          select: { ...requests[0].participantSelect, raceId: true },
          orderBy: { totalSteps: "desc" },
          take: 3,
        });
        byRaceId.set(raceId, rows || []);
      }
      for (const request of requests) {
        request.resolve(byRaceId.get(request.raceId) || []);
      }
    });
    return promise;
  }

  function loadBoundedLegacyRoster({ prisma, raceId, userId }) {
    const queue = stateFor(prisma).boundedLegacyRosters;
    const promise = new Promise((resolve, reject) => {
      queue.pending.push({ raceId, userId, resolve, reject });
    });
    scheduleBoundedBatchDrain(queue, async (requests) => {
      for (const page of chunks(requests)) {
        const unique = [...new Map(page.map((request) => [
          `${request.raceId}\u0000${request.userId}`,
          { raceId: request.raceId, userId: request.userId },
        ])).values()];
        const requestedValues = Prisma.join(unique.map(({ raceId, userId }) =>
          Prisma.sql`(${raceId}, ${userId})`));
        const rows = await prisma.$queryRaw`
          WITH requested(race_id,viewer_user_id) AS (
            VALUES ${requestedValues}
          ), ranked AS (
            SELECT
              participant.id,
              participant.race_id,
              participant.user_id,
              participant.status::text AS status,
              participant.total_steps,
              participant.raw_steps,
              participant.placement,
              participant.finished_at,
              participant.forfeited_at,
              participant.team::text AS team,
              participant.payout_coins,
              participant.buy_in_amount,
              participant.buy_in_status::text AS buy_in_status,
              ROW_NUMBER() OVER (
                PARTITION BY participant.race_id
                ORDER BY participant.total_steps DESC,
                         participant.joined_at ASC,
                         participant.user_id COLLATE "C" ASC
              )::int AS computed_placement,
              COUNT(*) OVER (PARTITION BY participant.race_id)::int AS total_count
            FROM race_participants participant
            WHERE participant.race_id IN (${Prisma.join(
              [...new Set(unique.map((request) => request.raceId))],
            )})
              AND participant.status='accepted'::"RaceParticipantStatus"
          )
          SELECT
            requested.viewer_user_id AS "viewerUserId",
            ranked.id,
            ranked.race_id AS "raceId",
            ranked.user_id AS "userId",
            UPPER(ranked.status) AS status,
            ranked.total_steps AS "totalSteps",
            ranked.raw_steps AS "rawSteps",
            ranked.placement,
            ranked.finished_at AS "finishedAt",
            ranked.forfeited_at AS "forfeitedAt",
            UPPER(ranked.team) AS team,
            ranked.payout_coins AS "payoutCoins",
            ranked.buy_in_amount AS "buyInAmount",
            UPPER(ranked.buy_in_status) AS "buyInStatus",
            ranked.computed_placement AS "computedPlacement",
            ranked.total_count AS "totalCount"
          FROM requested
          JOIN ranked ON ranked.race_id=requested.race_id
           AND (ranked.computed_placement <= 3 OR
                ranked.user_id=requested.viewer_user_id)
          ORDER BY requested.viewer_user_id,ranked.computed_placement
        `;
        const grouped = new Map(unique.map(({ raceId, userId }) => [
          `${raceId}\u0000${userId}`,
          [],
        ]));
        for (const row of rows || []) {
          grouped.get(`${row.raceId}\u0000${row.viewerUserId}`)?.push(row);
        }
        for (const request of page) {
          request.resolve(grouped.get(
            `${request.raceId}\u0000${request.userId}`,
          ) || []);
        }
      }
    });
    return promise;
  }

  function loadPendingInvites({ prisma, userId, now, select }) {
    const queue = stateFor(prisma).pending;
    const promise = new Promise((resolve, reject) => {
      queue.pending.push({ userId, now, select, resolve, reject });
    });
    scheduleBoundedBatchDrain(queue, async (requests) => {
      for (const page of chunks(requests)) {
        const ids = [...new Set(page.map((request) => request.userId))];
        const oldestNow = new Date(Math.min(...page.map((request) => request.now.getTime())));
        const rows = await prisma.raceParticipant.findMany({
          where: {
            userId: { in: ids },
            status: "INVITED",
            race: { status: "PENDING" },
            OR: [{ inviteExpiresAt: null }, { inviteExpiresAt: { gt: oldestNow } }],
          },
          select: { ...page[0].select, userId: true },
          orderBy: [{ inviteExpiresAt: "asc" }, { joinedAt: "asc" }],
        });
        const grouped = new Map(ids.map((id) => [id, []]));
        for (const row of rows || []) grouped.get(row.userId)?.push(row);
        for (const request of page) {
          request.resolve((grouped.get(request.userId) || []).filter((row) =>
            row.inviteExpiresAt == null ||
            new Date(row.inviteExpiresAt).getTime() > request.now.getTime()));
        }
      }
    });
    return promise;
  }

  function loadActiveRows({
    prisma, userId, supportsTeamRaces, select, maxRows,
  }) {
    const queue = supportsTeamRaces
      ? stateFor(prisma).activeTeam
      : stateFor(prisma).activeIndividual;
    const promise = new Promise((resolve, reject) => {
      queue.pending.push({ userId, supportsTeamRaces, select, maxRows, resolve, reject });
    });
    scheduleBoundedBatchDrain(queue, async (requests) => {
      for (const page of chunks(requests)) {
        const ids = [...new Set(page.map((request) => request.userId))];
        const rows = await prisma.raceParticipant.findMany({
          where: {
            userId: { in: ids },
            status: "ACCEPTED",
            race: {
              status: "ACTIVE",
              tournamentId: null,
              ...(page[0].supportsTeamRaces ? {} : { isTeamRace: false }),
            },
          },
          select: { ...page[0].select, userId: true },
          orderBy: { race: { startedAt: "desc" } },
        });
        const grouped = new Map(ids.map((id) => [id, []]));
        for (const row of rows || []) grouped.get(row.userId)?.push(row);
        for (const request of page) {
          const ordered = grouped.get(request.userId) || [];
          ordered.sort((left, right) =>
            new Date(right.race?.startedAt || 0) - new Date(left.race?.startedAt || 0));
          request.resolve(ordered.slice(0, request.maxRows));
        }
      }
    });
    return promise;
  }

  function loadUsers({ prisma, userIds, select }) {
    const queue = stateFor(prisma).users;
    const ids = [...new Set((userIds || []).filter(Boolean))];
    if (ids.length === 0) return Promise.resolve([]);
    const promise = new Promise((resolve, reject) => {
      queue.pending.push({ ids, select, resolve, reject });
    });
    scheduleBoundedBatchDrain(queue, async (requests) => {
      // Every home-card call uses the same USER_SELECT. Keeping the queue tied
      // to one Prisma client makes this invariant explicit and bounded.
      const union = [...new Set(requests.flatMap((request) => request.ids))];
      const byId = new Map();
      if (prisma === defaultPrismaClient) {
        const loaded = await presentationCache.getMany(union, true);
        for (const [id, row] of loaded) {
          if (row) byId.set(id, row);
        }
      } else {
        for (const page of chunks(union)) {
          const rows = await prisma.user.findMany({
            where: { id: { in: page } },
            select: requests[0].select,
          });
          for (const row of rows || []) byId.set(row.id, row);
        }
      }
      for (const request of requests) {
        request.resolve(request.ids.map((id) => byId.get(id)).filter(Boolean));
      }
    });
    return promise;
  }

  return {
    loadAcceptedRoster,
    loadActiveRows,
    loadBoundedLegacyRoster,
    loadLegacyActiveRow,
    loadPendingInvites,
    loadTopAcceptedRoster,
    loadUsers,
  };
}

const homeLaunchReadBatch = createHomeLaunchReadBatch();

module.exports = { BATCH_SIZE, createHomeLaunchReadBatch, homeLaunchReadBatch };
