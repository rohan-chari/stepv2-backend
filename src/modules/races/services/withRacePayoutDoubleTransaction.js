const { prisma } = require("../../../db");

const RETRYABLE_CODES = new Set(["40P01", "40001", "P2034"]);

function databaseCode(error) {
  // Prisma wraps raw-query Postgres errors as P2010 and retains the SQLSTATE in
  // meta.code. Prefer that nested value so serialization/deadlock retries are
  // not mistaken for a permanent Prisma client failure.
  if (error?.code === "P2010") {
    return error?.meta?.code ||
      error?.meta?.driverAdapterError?.cause?.originalCode ||
      error?.meta?.driverAdapterError?.cause?.code ||
      error.code;
  }
  return error?.code || error?.meta?.code || error?.cause?.code || null;
}

async function withRacePayoutDoubleTransaction(work, dependencies = {}) {
  const db = dependencies.prisma || prisma;
  const attempts = dependencies.transactionAttempts || 3;
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await db.$transaction(work, {
        isolationLevel: "Serializable",
        timeout: 10_000,
      });
    } catch (error) {
      lastError = error;
      if (!RETRYABLE_CODES.has(databaseCode(error)) || attempt + 1 >= attempts) {
        throw error;
      }
    }
  }
  throw lastError;
}

module.exports = { withRacePayoutDoubleTransaction };
