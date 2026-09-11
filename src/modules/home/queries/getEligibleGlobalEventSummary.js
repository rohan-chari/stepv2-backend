const { Prisma } = require("@prisma/client");
const { prisma: defaultPrisma } = require("../../../db");
const {
  homeLaunchAuxiliaryBatch,
} = require("../services/homeLaunchAuxiliaryBatch");

// One authoritative Postgres predicate for both Home response builders. An
// aggregate net of zero is still eligible; only an all-zero per-race vector is
// suppressed.
async function getEligibleGlobalEventSummary({ prisma, userId }) {
  if (!prisma || prisma === defaultPrisma) {
    return homeLaunchAuxiliaryBatch.loadGlobalEventSummary({
      prisma: prisma || defaultPrisma,
      userId,
    });
  }
  const rows = await require('./readSavedEventRecaps').readSavedEventRecaps(prisma, [userId]);
  const row = rows[0];
  if (!row || !Number.isInteger(row.remainingMsAtLoad) || row.remainingMsAtLoad <= 0) {
    return null;
  }
  const { remainingMsAtLoad, ...summary } = row;
  return { ...summary, validForMs: remainingMsAtLoad };
}

module.exports = { getEligibleGlobalEventSummary };
