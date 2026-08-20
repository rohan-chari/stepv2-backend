const { PERMANENT_FLAGS } = require("./appSettings");

const MIN_DELAY_MS = 7 * 24 * 60 * 60 * 1000;

function assertCleanupDelayElapsed(evidenceTimestamp, now = new Date()) {
  const evidenceAt = new Date(evidenceTimestamp);
  if (Number.isNaN(evidenceAt.getTime()) || now.getTime() - evidenceAt.getTime() < MIN_DELAY_MS) {
    throw new Error("Retired AppSetting deletion requires a completed seven-day rollback window");
  }
  return evidenceAt;
}

function requiredEvidenceDate(evidence, key, label) {
  const value = new Date(evidence?.[key]);
  if (Number.isNaN(value.getTime())) {
    throw new Error(`Retired AppSetting deletion requires ${label} evidence`);
  }
  return value;
}

function assertCleanupEvidence(evidence, now = new Date()) {
  if (!evidence || typeof evidence !== "object") {
    throw new Error("Retired AppSetting deletion requires deployment and restore-drill evidence");
  }
  const deploymentCompletedAt = requiredEvidenceDate(
    evidence,
    "deploymentCompletedAt",
    "completed deployment",
  );
  const noOldWorkerObservedAt = requiredEvidenceDate(
    evidence,
    "noOldWorkerObservedAt",
    "no-old-worker observation",
  );
  const restoreDrillCompletedAt = requiredEvidenceDate(
    evidence,
    "restoreDrillCompletedAt",
    "completed restore drill",
  );
  if (!String(evidence.restoreDrillId || "").trim()) {
    throw new Error("Retired AppSetting deletion requires a restore drill artifact ID");
  }
  if (
    noOldWorkerObservedAt < deploymentCompletedAt ||
    restoreDrillCompletedAt < deploymentCompletedAt
  ) {
    throw new Error("Cleanup evidence must postdate the cleanup deployment");
  }
  assertCleanupDelayElapsed(noOldWorkerObservedAt, now);
  return {
    deploymentCompletedAt,
    noOldWorkerObservedAt,
    restoreDrillCompletedAt,
    restoreDrillId: String(evidence.restoreDrillId).trim(),
  };
}

async function cleanupRetiredAppSettings({ prisma, apply = false, evidence, now = new Date() }) {
  const keys = Object.keys(PERMANENT_FLAGS).sort();
  const rows = await prisma.appSetting.findMany({ where: { key: { in: keys } }, orderBy: { key: "asc" } });
  if (!apply) return { keys, rows, deleted: 0 };
  assertCleanupEvidence(evidence, now);
  const result = await prisma.appSetting.deleteMany({ where: { key: { in: keys } } });
  return { keys, rows, deleted: result.count };
}

module.exports = {
  MIN_DELAY_MS,
  assertCleanupDelayElapsed,
  assertCleanupEvidence,
  cleanupRetiredAppSettings,
};
