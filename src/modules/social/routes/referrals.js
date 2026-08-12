const { Router } = require("express");
const { buildRequireAuth } = require("../../../middleware/requireAuth");
const {
  getOrCreateReferralCode: defaultGetOrCreateReferralCode,
} = require("../commands/getOrCreateReferralCode");
const {
  redeemReferralCode: defaultRedeemReferralCode,
  buildRedeemReferralCode,
} = require("../commands/redeemReferralCode");
const {
  getReferralStatus: defaultGetReferralStatus,
} = require("../queries/getReferralStatus");
const {
  getReferralPreview: defaultGetReferralPreview,
} = require("../queries/getReferralPreview");
const {
  getInviterRace: defaultGetInviterRace,
} = require("../queries/getInviterRace");
const { buildShareUrl: defaultBuildShareUrl } = require("../../web").sharing;

// All routes are additive — older app binaries never call them, and older
// backends 404 them (clients degrade gracefully). See §5A / §7.
function createReferralsRouter(dependencies = {}) {
  const router = Router();
  const requireAuth =
    dependencies.requireAuth || buildRequireAuth(dependencies);
  const getOrCreateCode =
    dependencies.getOrCreateReferralCode || defaultGetOrCreateReferralCode;
  const redeem =
    dependencies.redeemReferralCode ||
    (dependencies.prisma || dependencies.beforeAutoFriendWrite
      ? buildRedeemReferralCode(dependencies)
      : defaultRedeemReferralCode);
  const getStatus = dependencies.getReferralStatus || defaultGetReferralStatus;
  const getPreview =
    dependencies.getReferralPreview || defaultGetReferralPreview;
  const shareUrl = dependencies.buildShareUrl || defaultBuildShareUrl;
  const inviterRace = dependencies.getInviterRace || defaultGetInviterRace;

  // GET /referrals/me — AUTHED. Declared with inline requireAuth BEFORE the
  // public GET /:code so "me" is never captured as a :code param.
  router.get("/me", requireAuth, async (req, res) => {
    try {
      const code = await getOrCreateCode({ userId: req.user.id });
      const status = await getStatus({ userId: req.user.id });
      res.json({ code, url: shareUrl(code), ...status });
    } catch (error) {
      console.error("Referral status error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /referrals/inviter-race — AUTHED (onboarding revamp §6.3). Like /me,
  // declared with inline requireAuth BEFORE the public GET /:code so the literal
  // path is never captured as a :code param.
  //
  // Always 200. Every miss is { race: null, inviter: null } — never an error —
  // so the client's fallback to the Daily intro is one branch, not three.
  router.get("/inviter-race", requireAuth, async (req, res) => {
    try {
      const result = await inviterRace({ userId: req.user.id });
      res.json(result);
    } catch (error) {
      console.error("Inviter race lookup error:", error);
      // An onboarding screen must never dead-end on this. Degrade to the same
      // shape the client already handles rather than surfacing a 500.
      res.json({ race: null, inviter: null });
    }
  });

  // GET /referrals/:code — PUBLIC, display-safe preview (no auth, no PII).
  // Declared before the requireAuth gate below but AFTER /me (so /me wins).
  // Mirrors the races.js public-route-before-requireAuth ordering.
  router.get("/:code", async (req, res) => {
    try {
      const preview = await getPreview({ code: req.params.code });
      if (!preview) {
        return res.status(404).json({ error: "Referral not found" });
      }
      res.json({ referral: preview });
    } catch (error) {
      console.error("Referral preview error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.use(requireAuth);

  // POST /referrals/link — lazily mint/return the caller's stable code + url.
  router.post("/link", async (req, res) => {
    try {
      const code = await getOrCreateCode({ userId: req.user.id });
      res.json({ code, url: shareUrl(code) });
    } catch (error) {
      console.error("Referral link error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /referrals/redeem — attach a referrer after signup (iOS tap / manual).
  // Body: { referralCode }. Always 200 with {attributed, reason?} so the client
  // can show a friendly result; only infra failures 500.
  router.post("/redeem", async (req, res) => {
    try {
      const result = await redeem({
        user: req.user,
        referralCode: req.body && req.body.referralCode,
      });
      res.json(result);
    } catch (error) {
      console.error("Referral redeem error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}

module.exports = { createReferralsRouter };
