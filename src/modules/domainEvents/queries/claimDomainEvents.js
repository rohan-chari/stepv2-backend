const repository = require("../models/domainEventOutbox");

function buildClaimDomainEvents(dependencies = {}) {
  const repo = dependencies.repository || repository;
  const prisma = dependencies.prisma;
  return function claimDomainEvents(options = {}) {
    return repo.claimEvents({ ...options, ...(prisma ? { prisma } : {}) });
  };
}

module.exports = { buildClaimDomainEvents };
