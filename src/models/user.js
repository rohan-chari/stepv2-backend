const { prisma } = require("../db");

const User = {
  async findById(id) {
    return prisma.user.findUnique({ where: { id } });
  },

  async findByAppleId(appleId) {
    return prisma.user.findUnique({ where: { appleId } });
  },

  async create({ appleId, email, name }) {
    return prisma.user.create({
      data: { appleId, email, name },
    });
  },

  async update(id, fields) {
    return prisma.user.update({
      where: { id },
      data: fields,
    });
  },
};

module.exports = { User };
