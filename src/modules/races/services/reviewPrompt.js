const { randomUUID } = require("node:crypto");

const COOLDOWN_MS = 180 * 24 * 60 * 60 * 1000;
const OPPORTUNITY_MS = 30 * 24 * 60 * 60 * 1000;

// Called only after a normal individual winner is frozen. The durable row is
// an opportunity, not an assertion that iOS/Android showed a dialog; claiming
// it records an attempt because native APIs intentionally do not report UI.
async function createReviewOpportunity({ prisma, userId, raceId, now = new Date() }) {
  if (!userId || !raceId) return null;
  const cooldownStart = new Date(now.getTime() - COOLDOWN_MS);
  const write = async (tx) => {
    // The cooldown is per person, not per race. Serialize competing race
    // completions for one winner so two concurrent settlements cannot both
    // observe an empty 180-day window and mint two opportunities.
    if (typeof tx.$executeRawUnsafe === "function") {
      await tx.$executeRawUnsafe(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        `review-prompt:${userId}`
      );
    }
    const prior = await tx.appReviewPromptAttempt.findFirst({
      where: { userId, attemptedAt: { gte: cooldownStart } }, select: { id: true },
    });
    if (prior) return null;
    try {
      return await tx.appReviewPromptAttempt.create({
        data: {
          userId, raceId, opportunityId: randomUUID(),
          expiresAt: new Date(now.getTime() + OPPORTUNITY_MS),
        },
      });
    } catch (error) {
      // Race settlement is authoritative and must remain retryable if a previous
      // attempt won the unique (user,race) race.
      if (error?.code === "P2002") return null;
      throw error;
    }
  };
  return typeof prisma.$transaction === "function" ? prisma.$transaction(write) : write(prisma);
}

module.exports = { createReviewOpportunity, COOLDOWN_MS, OPPORTUNITY_MS };
