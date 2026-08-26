const repository = require("../models/domainEventOutbox");

function buildClaimNotificationProjections(dependencies = {}) {
  const repo = dependencies.repository || repository;
  const prisma = dependencies.prisma;
  return function claimNotificationProjections(options = {}) {
    return repo.claimProjections({ ...options, ...(prisma ? { prisma } : {}) });
  };
}

module.exports = { buildClaimNotificationProjections };
