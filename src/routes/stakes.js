const { Router } = require("express");
const { buildRequireAuth } = require("../middleware/requireAuth");
const {
  getStakeCatalog: defaultGetStakeCatalog,
} = require("../queries/getStakeCatalog");

function createStakesRouter(dependencies = {}) {
  const router = Router();
  const requireAuth =
    dependencies.requireAuth || buildRequireAuth(dependencies);

  const getStakeCatalog =
    dependencies.getStakeCatalog || defaultGetStakeCatalog;

  router.use(requireAuth);

  // GET /stakes?relationship_type=partner
  router.get("/", async (req, res) => {
    try {
      const stakes = await getStakeCatalog({
        relationshipType: req.query.relationship_type,
      });
      res.json({ stakes });
    } catch (error) {
      console.error("Stake catalog error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}

module.exports = { createStakesRouter };
