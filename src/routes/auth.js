const { Router } = require("express");
const {
  AppleIdentityTokenError,
  verifyAppleIdentityToken,
} = require("../services/appleIdentityToken");
const { ensureAppleUser } = require("../services/ensureAppleUser");
const { buildRequireAuth } = require("../middleware/requireAuth");
const { signSessionToken: defaultSignSessionToken } = require("../services/sessionToken");
const { setStepGoal: defaultSetStepGoal } = require("../commands/setStepGoal");
const { setDisplayName: defaultSetDisplayName } = require("../commands/setDisplayName");
const { getIncomingFriendRequestCount: defaultGetIncomingFriendRequestCount } = require("../queries/getFriends");
const { User: DefaultUser } = require("../models/user");

const DISPLAY_NAME_MIN_LENGTH = 8;
const { isAdminUser, withAdminFlag } = require("../services/adminAccess");

function createAuthRouter(dependencies = {}) {
  const router = Router();
  const verifyIdentityToken =
    dependencies.verifyAppleIdentityToken || verifyAppleIdentityToken;
  const provisionUser = dependencies.ensureAppleUser || ensureAppleUser;
  const requireAuth =
    dependencies.requireAuth || buildRequireAuth(dependencies);
  const signToken = dependencies.signSessionToken || defaultSignSessionToken;
  const updateStepGoal = dependencies.setStepGoal || defaultSetStepGoal;
  const updateDisplayName = dependencies.setDisplayName || defaultSetDisplayName;
  const getIncomingRequestCount = dependencies.getIncomingFriendRequestCount || defaultGetIncomingFriendRequestCount;
  const checkAdmin = dependencies.isAdminUser || isAdminUser;
  const UserModel = dependencies.User || DefaultUser;

  async function getHeldCoinsSafe(userId) {
    if (!UserModel.getHeldCoins) {
      return 0;
    }

    try {
      return await UserModel.getHeldCoins(userId);
    } catch (error) {
      console.warn("Held coin lookup failed:", error.message || error);
      return 0;
    }
  }

  // POST /auth/apple
  // Body: { identityToken, userIdentifier?, email?, name? }
  router.post("/apple", async (req, res) => {
    try {
      const { identityToken, userIdentifier, email, name } = req.body;

      if (!identityToken) {
        return res.status(400).json({ error: "identityToken is required" });
      }

      const appleIdentity = await verifyIdentityToken(identityToken);

      if (userIdentifier && userIdentifier !== appleIdentity.sub) {
        return res.status(401).json({ error: "Apple user identifier does not match token subject" });
      }

      const user = await provisionUser({
        appleId: appleIdentity.sub,
        email: email || appleIdentity.email,
        name,
        emitSignInEvent: true,
      });

      const sessionToken = signToken({
        userId: user.id,
        appleId: appleIdentity.sub,
      });

      res.json({ user: withAdminFlag(user, checkAdmin), sessionToken });
    } catch (error) {
      if (error instanceof AppleIdentityTokenError) {
        return res.status(401).json({ error: error.message });
      }

      console.error("Auth error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.get("/me", requireAuth, async (req, res) => {
    try {
      const incomingFriendRequests = await getIncomingRequestCount(req.user.id);
      const heldCoins = await getHeldCoinsSafe(req.user.id);
      res.json({
        user: withAdminFlag(
          { ...req.user, incomingFriendRequests, heldCoins },
          checkAdmin
        ),
      });
    } catch (error) {
      console.error("Get me error:", error);
      res.json({ user: req.user });
    }
  });

  // GET /auth/session — refresh session token
  router.get("/session", requireAuth, async (req, res) => {
    const sessionToken = signToken({
      userId: req.user.id,
      appleId: req.user.appleId,
    });

    const heldCoins = await getHeldCoinsSafe(req.user.id);
    res.json({
      sessionToken,
      user: withAdminFlag({ ...req.user, heldCoins }, checkAdmin),
    });
  });

  router.put("/me/step-goal", requireAuth, async (req, res) => {
    const { stepGoal } = req.body;

    if (stepGoal === undefined) {
      return res.status(400).json({ error: "stepGoal is required" });
    }

    if (!Number.isInteger(stepGoal) || stepGoal < 5000) {
      return res
        .status(400)
        .json({ error: "stepGoal must be at least 5000" });
    }

    const updatedUser = await updateStepGoal({
      userId: req.user.id,
      stepGoal,
    });

    res.json({ user: updatedUser });
  });

  router.put("/me/display-name", requireAuth, async (req, res) => {
    const { displayName } = req.body;

    if (displayName === undefined) {
      return res.status(400).json({ error: "displayName is required" });
    }

    if (displayName !== null) {
      if (typeof displayName !== "string") {
        return res
          .status(400)
          .json({ error: "displayName must be a non-empty string or null" });
      }

      const trimmed = displayName.trim();
      if (trimmed.length === 0) {
        return res
          .status(400)
          .json({ error: "displayName must be a non-empty string or null" });
      }

      if (trimmed.length < DISPLAY_NAME_MIN_LENGTH) {
        return res
          .status(400)
          .json({ error: `displayName must be at least ${DISPLAY_NAME_MIN_LENGTH} characters` });
      }

      try {
        const updatedUser = await updateDisplayName({
          userId: req.user.id,
          displayName: trimmed,
        });

        return res.json({ user: updatedUser });
      } catch (error) {
        if (error.name === "DisplayNameTakenError") {
          return res.status(409).json({ error: error.message });
        }
        console.error("Display name error:", error);
        return res.status(500).json({ error: "Internal server error" });
      }
    }

    try {
      const updatedUser = await updateDisplayName({
        userId: req.user.id,
        displayName: null,
      });

      res.json({ user: updatedUser });
    } catch (error) {
      if (error instanceof DisplayNameTakenError) {
        return res.status(409).json({ error: error.message });
      }
      console.error("Display name error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.get("/check-display-name", requireAuth, async (req, res) => {
    const { name } = req.query;

    if (!name || typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "name query parameter is required" });
    }

    const trimmed = name.trim();

    if (trimmed.length < DISPLAY_NAME_MIN_LENGTH) {
      return res.json({ available: false, reason: `Must be at least ${DISPLAY_NAME_MIN_LENGTH} characters` });
    }

    const existing = await UserModel.findByDisplayNameInsensitive(trimmed, req.user.id);
    res.json({ available: !existing });
  });

  return router;
}

module.exports = { createAuthRouter, DISPLAY_NAME_MIN_LENGTH };
