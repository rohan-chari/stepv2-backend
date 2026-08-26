const { Router } = require("express");
const { buildRequireAuth } = require("../../middleware/requireAuth");
const {
  getRaceJoinRequest: defaultGetRaceJoinRequest,
} = require("./queries/getRaceJoinRequest");
const { RaceJoinRequestError } = require("./services/raceJoinRequests");

function createRaceJoinRequestsRouter(dependencies = {}) {
  const router = Router();
  const requireAuth = dependencies.requireAuth || buildRequireAuth(dependencies);
  const getRaceJoinRequest =
    dependencies.getRaceJoinRequest || defaultGetRaceJoinRequest;

  router.use(requireAuth);
  router.get("/:requestId", async (req, res) => {
    try {
      const result = await getRaceJoinRequest({
        requestId: req.params.requestId,
        requesterUserId: req.user.id,
        prisma: dependencies.prisma,
      });
      res.json(result);
    } catch (error) {
      if (error instanceof RaceJoinRequestError ||
          error?.name === "RaceJoinRequestError") {
        return res.status(error.statusCode || 400).json({
          error: error.message,
          ...(error.code ? { code: error.code } : {}),
          ...(error.meta || {}),
        });
      }
      console.error("Get race join request error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}

module.exports = { createRaceJoinRequestsRouter };
