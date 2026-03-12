const { Router } = require("express");
const {
  AppleIdentityTokenError,
  verifyAppleIdentityToken,
} = require("../services/appleIdentityToken");
const { ensureAppleUser } = require("../services/ensureAppleUser");
const { buildRequireAppleAuth } = require("../middleware/requireAppleAuth");
const { setStepGoal: defaultSetStepGoal } = require("../commands/setStepGoal");
const { setDisplayName: defaultSetDisplayName } = require("../commands/setDisplayName");
const { getIncomingFriendRequestCount: defaultGetIncomingFriendRequestCount } = require("../queries/getFriends");

function createAuthRouter(dependencies = {}) {
  const router = Router();
  const verifyIdentityToken =
    dependencies.verifyAppleIdentityToken || verifyAppleIdentityToken;
  const provisionUser = dependencies.ensureAppleUser || ensureAppleUser;
  const requireAppleAuth =
    dependencies.requireAppleAuth || buildRequireAppleAuth(dependencies);
  const updateStepGoal = dependencies.setStepGoal || defaultSetStepGoal;
  const updateDisplayName = dependencies.setDisplayName || defaultSetDisplayName;
  const getIncomingRequestCount = dependencies.getIncomingFriendRequestCount || defaultGetIncomingFriendRequestCount;

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

      res.json({ user });
    } catch (error) {
      if (error instanceof AppleIdentityTokenError) {
        return res.status(401).json({ error: error.message });
      }

      console.error("Auth error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.get("/me", requireAppleAuth, async (req, res) => {
    try {
      const incomingFriendRequests = await getIncomingRequestCount(req.user.id);
      res.json({ user: { ...req.user, incomingFriendRequests } });
    } catch (error) {
      console.error("Get me error:", error);
      res.json({ user: req.user });
    }
  });

  router.put("/me/step-goal", requireAppleAuth, async (req, res) => {
    const { stepGoal } = req.body;

    if (stepGoal === undefined) {
      return res.status(400).json({ error: "stepGoal is required" });
    }

    if (stepGoal !== null && (!Number.isInteger(stepGoal) || stepGoal <= 0)) {
      return res
        .status(400)
        .json({ error: "stepGoal must be a positive integer or null" });
    }

    const updatedUser = await updateStepGoal({
      userId: req.user.id,
      stepGoal,
    });

    res.json({ user: updatedUser });
  });

  router.put("/me/display-name", requireAppleAuth, async (req, res) => {
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

  return router;
}

module.exports = { createAuthRouter };
