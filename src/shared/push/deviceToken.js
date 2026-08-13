const { prisma } = require("../../db");

const DeviceToken = {
  async saveToken({ userId, token, platform }) {
    return prisma.deviceToken.upsert({
      where: { userId_token: { userId, token } },
      update: { platform },
      create: { userId, token, platform },
    });
  },

  async deleteToken({ userId, token }) {
    return prisma.deviceToken.deleteMany({ where: { userId, token } });
  },

  async findByUserId(userId) {
    return prisma.deviceToken.findMany({ where: { userId } });
  },

  async findByUserIds(userIds) {
    const ids = [...new Set(userIds || [])].filter(Boolean);
    if (ids.length === 0) return [];
    return prisma.deviceToken.findMany({ where: { userId: { in: ids } } });
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

module.exports = { DeviceToken };
