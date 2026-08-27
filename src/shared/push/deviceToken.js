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
