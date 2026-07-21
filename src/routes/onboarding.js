const { Router } = require("express");
const { prisma: defaultPrisma } = require("../db");
const { buildRequireAuth } = require("../middleware/requireAuth");
const { awardCoins: defaultAwardCoins } = require("../shared/economy/awardCoins");

const STARTER_REWARD_COINS = 100;
// Deliberately identical to the legacy tutorial grant. Together with refId=userId
// this is one ledger key across old tutorial and new Daily activation flows.
const STARTER_REWARD_REASON = "tutorial_complete";

async function findActiveDailyMembership(prisma, userId) {
  return prisma.raceParticipant.findFirst({
    where: {
      userId,
      status: "ACCEPTED",
      race: {
        status: "ACTIVE",
        // Seed activation controls minting future races; it must not revoke a
        // reward from a Daily race that is already live.
        seed: { is: { kind: "DAILY_10K" } },
      },
    },
    select: { raceId: true },
    orderBy: { joinedAt: "desc" },
  });
}

function createOnboardingRouter(dependencies = {}) {
  const router = Router();
  const prisma = dependencies.prisma || defaultPrisma;
  const requireAuth = dependencies.requireAuth || buildRequireAuth(dependencies);
  const awardCoins = dependencies.awardCoins || defaultAwardCoins;

  router.use(requireAuth);

  router.get("/starter-reward", async (req, res) => {
    try {
      const userId = req.user.id;
      const [membership, ledgerEntry] = await Promise.all([
        findActiveDailyMembership(prisma, userId),
        prisma.coinTransaction.findFirst({
          where: {
            userId,
            reason: STARTER_REWARD_REASON,
            refId: userId,
          },
          select: { id: true },
        }),
      ]);
      const claimed = Boolean(ledgerEntry);
      res.json({
        eligible: Boolean(membership) && !claimed,
        claimed,
        amount: STARTER_REWARD_COINS,
        ...(membership ? { raceId: membership.raceId } : {}),
      });
    } catch (error) {
      console.error("Starter reward eligibility error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.post("/starter-reward/claim", async (req, res) => {
    try {
      const userId = req.user.id;
      const membership = await findActiveDailyMembership(prisma, userId);
      if (!membership) {
        return res.status(403).json({
          error: "Starter reward requires an accepted active Daily race",
          code: "STARTER_REWARD_NOT_ELIGIBLE",
        });
      }

      const { awarded, coins } = await awardCoins({
        userId,
        amount: STARTER_REWARD_COINS,
        reason: STARTER_REWARD_REASON,
        refId: userId,
      });
      return res.json({ granted: awarded, coins });
    } catch (error) {
      console.error("Starter reward claim error:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}

module.exports = {
  createOnboardingRouter,
  findActiveDailyMembership,
  STARTER_REWARD_COINS,
  STARTER_REWARD_REASON,
};
