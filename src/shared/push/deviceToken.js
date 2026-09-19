const { prisma } = require("../../db");

async function activeStatusFilter(client = prisma) {
  const state = await client.globalStepEventGenerationState.findUnique({
    where: { id: 1 },
    select: { quarantineStartedAt: true },
  });
  return state?.quarantineStartedAt
    ? { status: "ACTIVE" }
    : { OR: [{ status: "ACTIVE" }, { status: null }] };
}

const DeviceToken = {
  async saveToken({ userId, token, platform, adminMetricsOpenCapable = false, adminMetricsOpenEpochId = null }) {
    return prisma.deviceToken.upsert({
      where: { userId_token: { userId, token } },
      update: {
        platform,
        ...(adminMetricsOpenCapable
          ? { adminMetricsOpenCapable: true, adminMetricsOpenEpochId }
          : {}),
      },
      create: {
        userId,
        token,
        platform,
        adminMetricsOpenCapable,
        adminMetricsOpenEpochId: adminMetricsOpenCapable
          ? adminMetricsOpenEpochId
          : null,
      },
    });
  },

  async deleteToken({ userId, token }) {
    return prisma.deviceToken.deleteMany({ where: { userId, token } });
  },

  async findByUserId(userId) {
    const status = await activeStatusFilter();
    return prisma.deviceToken.findMany({
      where: { userId, ...status },
      orderBy: [{ lastRegisteredAt: "desc" }, { updatedAt: "desc" }, { id: "desc" }],
      take: 10,
    });
  },

  async findByUserIds(userIds) {
    const ids = [...new Set(userIds || [])].filter(Boolean);
    if (ids.length === 0) return [];
    const status = await activeStatusFilter();
    return prisma.deviceToken.findMany({
      where: { userId: { in: ids }, ...status },
    });
  },

  // Delivery has a per-user cap, unlike findByUserIds' existing fanout contract.
  // Apply the cap in SQL so one user's token history cannot inflate the batch.
  async findForDeliveryByUserIds(userIds, client = prisma) {
    const ids = [...new Set(userIds || [])].filter(Boolean);
    if (!ids.length) return [];
    const status = await activeStatusFilter(client);
    const rows = [];
    for (let offset = 0; offset < ids.length; offset += 100) {
      rows.push(...await client.$queryRawUnsafe(`
        SELECT token.id, token.user_id AS "userId", token.token, token.platform
          FROM unnest($1::text[]) AS recipient(user_id)
          CROSS JOIN LATERAL (
            SELECT id, user_id, token, platform, last_registered_at, updated_at
              FROM device_tokens
             WHERE user_id = recipient.user_id
               AND (status = 'ACTIVE' OR ($2::boolean AND status IS NULL))
             ORDER BY last_registered_at DESC, updated_at DESC, id DESC
             LIMIT 10
          ) token
         ORDER BY token.user_id, token.last_registered_at DESC, token.updated_at DESC, token.id DESC`,
        ids.slice(offset, offset + 100), status.status !== "ACTIVE",
      ));
    }
    return rows;
  },

  async deleteTokensExact(pairs, chunkSize = 500) {
    const unique = [
      ...new Map(
        (pairs || [])
          .filter((pair) => pair?.userId && pair?.token)
          .map((pair) => [`${pair.userId}\u0000${pair.token}`, pair])
      ).values(),
    ];
    let deleted = 0;
    for (let start = 0; start < unique.length; start += chunkSize) {
      const chunk = unique.slice(start, start + chunkSize);
      const result = await prisma.deviceToken.deleteMany({
        where: {
          OR: chunk.map(({ userId, token }) => ({ userId, token })),
        },
      });
      deleted += result.count;
    }
    return deleted;
  },

  async findAll() {
    return prisma.deviceToken.findMany();
  },
};

module.exports = { DeviceToken, activeStatusFilter };
