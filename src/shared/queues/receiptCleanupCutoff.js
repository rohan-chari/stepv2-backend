const { prisma: defaultPrisma } = require("../../db");

const RECEIPT_CLEANUP_CUTOFF_JOB = "receipt_aware_payload_cleanup_cutoff_v1";
const RECEIPT_CLEANUP_OBSERVED_JOB = "receipt_aware_payload_cleanup_observed_v1";

async function isReceiptCleanupCutoffAccepted(prisma = defaultPrisma) {
  const row = await prisma.jobRun.findUnique({
    where: { jobName: RECEIPT_CLEANUP_CUTOFF_JOB },
    select: { lastRanFor: true },
  });
  return Boolean(row?.lastRanFor && !Number.isNaN(new Date(row.lastRanFor).getTime()));
}

async function acceptReceiptCleanupCutoff({
  acceptedAt = new Date(),
  prisma = defaultPrisma,
} = {}) {
  const stamp = acceptedAt.toISOString();
  return prisma.jobRun.upsert({
    where: { jobName: RECEIPT_CLEANUP_CUTOFF_JOB },
    create: { jobName: RECEIPT_CLEANUP_CUTOFF_JOB, lastRanFor: stamp },
    update: { lastRanFor: stamp },
  });
}

async function markReceiptCleanupCutoffObserved({
  observedAt = new Date(),
  prisma = defaultPrisma,
} = {}) {
  const stamp = observedAt.toISOString();
  return prisma.jobRun.upsert({
    where: { jobName: RECEIPT_CLEANUP_OBSERVED_JOB },
    create: { jobName: RECEIPT_CLEANUP_OBSERVED_JOB, lastRanFor: stamp },
    update: { lastRanFor: stamp },
  });
}

module.exports = {
  RECEIPT_CLEANUP_CUTOFF_JOB,
  RECEIPT_CLEANUP_OBSERVED_JOB,
  isReceiptCleanupCutoffAccepted,
  acceptReceiptCleanupCutoff,
  markReceiptCleanupCutoffObserved,
};
