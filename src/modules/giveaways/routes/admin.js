const { Router } = require("express");
const { buildRequireAuth } = require("../../../middleware/requireAuth");
const { buildRequireAdmin } = require("../../admin/requireAdmin");
const { asyncHandler } = require("../../../shared/http/asyncHandler");
const { buildGiveawayService } = require("../services/giveawayService");

function createGiveawayAdminRouter(dependencies = {}) {
  const router = Router();
  const service = dependencies.giveawayService || buildGiveawayService(dependencies);
  const requireAuth = dependencies.requireAuth || buildRequireAuth(dependencies);
  const requireAdmin = buildRequireAdmin(dependencies);
  router.use((req, res, next) => {
    res.set("Cache-Control", "private, no-store");
    return next();
  }, requireAuth, requireAdmin);

  router.get("/", asyncHandler(async (req, res) => res.json(await service.listAdmin(req.query.cursor, req.query.limit, req.clientFeatures))));
  router.post("/", asyncHandler(async (req, res) => res.status(201).json(await service.createDraft(req.user, req.headers["idempotency-key"], req.body, req.clientFeatures))));
  router.patch("/:id", asyncHandler(async (req, res) => res.json(await service.patchDraft(req.user, req.params.id, req.body, req.clientFeatures))));
  router.delete("/:id", asyncHandler(async (req, res) => {
    res.json(await service.deleteDraftContest({
      actorId: req.user.id,
      contestId: req.params.id,
      idempotencyKey: req.headers["idempotency-key"],
      body: req.body,
      supportsGlobal: req.clientFeatures?.has("referral_contest_global_v1") === true,
    }));
  }));
  router.get("/:id/candidates", asyncHandler(async (req, res) => res.json(await service.candidates(req.params.id, req.query.cursor, req.query.limit, req.clientFeatures))));
  router.get("/:id", asyncHandler(async (req, res) => res.json(await service.adminDetail(req.params.id, req.clientFeatures))));

  const mutations = {
    publish: "publish", cancel: "cancel", reviews: "review", finalize: "finalize",
    winner: "winner", "select-next": "selectNext", fulfillment: "fulfillment",
    "award-coins": "awardWinnerCoins", archive: "archive",
    "banner-correction": "bannerCorrection",
  };
  for (const [path, method] of Object.entries(mutations)) {
    router.post(`/:id/${path}`, asyncHandler(async (req, res) => {
      await service.contestById(req.params.id, req.clientFeatures);
      const payload = await service[method](req.user, req.params.id, req.headers["idempotency-key"], req.body, req.clientFeatures);
      res.json(payload);
    }));
  }
  return router;
}

module.exports = { createGiveawayAdminRouter };
