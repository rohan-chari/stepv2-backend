const { processReferralQualificationIntents } = require("../../social");

async function recoverReferralQualificationIntents(dependencies = {}) {
  return processReferralQualificationIntents({
    limit: dependencies.limit || 25,
    db: dependencies.prisma,
    now: dependencies.now,
    rewardOne: dependencies.rewardOne,
    retryDelayMs: dependencies.retryDelayMs,
  });
}

module.exports = { recoverReferralQualificationIntents };
