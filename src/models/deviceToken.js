const { prisma } = require("../db");

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

  async findAll() {
    return prisma.deviceToken.findMany();
  },
};

module.exports = { DeviceToken };
