const crypto = require("node:crypto");
const { Router } = require("express");
const { buildRequireAuth } = require("../../../middleware/requireAuth");
const { asyncHandler } = require("../../../shared/http/asyncHandler");
const { buildGiveawayService } = require("../services/giveawayService");
const { renderLanding, renderNoContest, renderRules } = require("../services/html");
const { buildGiveawayRateWindow } = require("../models/rateWindow");

function etag(payload) {
  return `"${crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex")}"`;
}

function createGiveawayPublicRouter(dependencies = {}) {
  const router = Router();
  const service = dependencies.giveawayService || buildGiveawayService(dependencies);
  const rateWindow = dependencies.giveawayRateWindow || buildGiveawayRateWindow(dependencies);
  const requireAuth = dependencies.requireAuth || buildRequireAuth(dependencies);

  router.get("/", asyncHandler(async (_req, res) => {
    const contest = await service.current();
    if (!contest) return res.status(200).type("html").send(renderNoContest());
    return res.redirect(302, `/giveaways/${encodeURIComponent(contest.slug)}`);
  }));

  router.get("/current/me", requireAuth, asyncHandler(async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    res.json(await service.memberCurrent(req.user, req.query.limit));
  }));

  router.post("/:slug/entries", requireAuth, asyncHandler(async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    await rateWindow.consumeEntry(req.user.id);
    const result = await service.enter(req.params.slug, req.user, req.body);
    res.status(result.created ? 201 : 200).json({ entry: result.entry });
  }));

  router.get("/:slug/data", asyncHandler(async (req, res) => {
    await rateWindow.consumePublic(req);
    const payload = await service.publicData(req.params.slug, req.query.limit);
    const tag = etag(payload);
    res.set("Cache-Control", "public, max-age=30");
    res.set("ETag", tag);
    if (req.headers["if-none-match"] === tag) return res.status(304).end();
    res.json(payload);
  }));

  router.get("/:slug/rules", asyncHandler(async (req, res) => {
    const contest = await service.publicBySlug(req.params.slug);
    res.set("Cache-Control", "public, max-age=30");
    res.type("html").send(renderRules(contest));
  }));

  router.get("/:slug", asyncHandler(async (req, res) => {
    await rateWindow.consumePublic(req);
    const payload = await service.publicData(req.params.slug, req.query.limit);
    res.set("Cache-Control", "public, max-age=30");
    res.type("html").send(renderLanding(payload));
  }));

  return router;
}

module.exports = { createGiveawayPublicRouter };
