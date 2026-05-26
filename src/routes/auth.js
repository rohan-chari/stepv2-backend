const { Router } = require("express");
const {
  AppleIdentityTokenError,
  verifyAppleIdentityToken,
} = require("../services/appleIdentityToken");
const { ensureAppleUser } = require("../services/ensureAppleUser");
const { buildRequireAuth } = require("../middleware/requireAuth");
const { signSessionToken: defaultSignSessionToken } = require("../services/sessionToken");
const { setDisplayName: defaultSetDisplayName } = require("../commands/setDisplayName");
const {
  InvalidProfilePhotoError,
  buildCreateProfilePhotoUpload,
  buildSetProfilePhoto,
  buildRemoveProfilePhoto,
  buildDismissProfilePhotoPrompt,
} = require("../commands/profilePhoto");
const {
  deleteUserAccount: defaultDeleteUserAccount,
  DeleteUserAccountError,
} = require("../commands/deleteUserAccount");
const { getIncomingFriendRequestCount: defaultGetIncomingFriendRequestCount } = require("../queries/getFriends");
const { User: DefaultUser } = require("../models/user");
const {
  ALLOWED_PROFILE_PHOTO_CONTENT_TYPES,
} = require("../services/profilePhotoStorage");

const {
  validateDisplayName,
  DISPLAY_NAME_MIN_LENGTH,
} = require("../lib/displayNameValidator");
const { isAdminUser, withAdminFlag } = require("../services/adminAccess");

// Reviewer account constants — kept in sync with scripts/seed-app-review-demo.js.
// The /auth/review endpoint auto-reprovisions the row if it's missing (e.g.
// reviewer deleted the account during a 5.1.1 compliance check), so we never
// lock the reviewer out and never block the in-app delete flow.
const REVIEWER_APPLE_ID = "review-account-v1";
const REVIEWER_DISPLAY_NAME = "AppReviewer";

function createAuthRouter(dependencies = {}) {
  const router = Router();
  const verifyIdentityToken =
    dependencies.verifyAppleIdentityToken || verifyAppleIdentityToken;
  const provisionUser = dependencies.ensureAppleUser || ensureAppleUser;
  const requireAuth =
    dependencies.requireAuth || buildRequireAuth(dependencies);
  const signToken = dependencies.signSessionToken || defaultSignSessionToken;
  const updateDisplayName = dependencies.setDisplayName || defaultSetDisplayName;
  const createProfilePhotoUpload =
    dependencies.createProfilePhotoUpload ||
    buildCreateProfilePhotoUpload(dependencies);
  const setProfilePhoto =
    dependencies.setProfilePhoto || buildSetProfilePhoto(dependencies);
  const removeProfilePhoto =
    dependencies.removeProfilePhoto || buildRemoveProfilePhoto(dependencies);
  const dismissProfilePhotoPrompt =
    dependencies.dismissProfilePhotoPrompt ||
    buildDismissProfilePhotoPrompt(dependencies);
  const getIncomingRequestCount = dependencies.getIncomingFriendRequestCount || defaultGetIncomingFriendRequestCount;
  const deleteUserAccount =
    dependencies.deleteUserAccount || defaultDeleteUserAccount;
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

  // POST /auth/review
  // Body: { email, password }
  // Bypass for App Store reviewers. Validates against APP_REVIEW_EMAIL /
  // APP_REVIEW_PASSWORD env vars and issues a session for the dedicated
  // reviewer user row. The reviewer account is otherwise a normal user;
  // there is no special flag on it (only seeded supporting cast is flagged).
  router.post("/review", async (req, res) => {
    try {
      const expectedEmail = process.env.APP_REVIEW_EMAIL;
      const expectedPassword = process.env.APP_REVIEW_PASSWORD;
      if (!expectedEmail || !expectedPassword) {
        return res.status(503).json({ error: "Review login is not configured" });
      }

      const { email, password } = req.body || {};
      if (typeof email !== "string" || typeof password !== "string") {
        return res.status(400).json({ error: "email and password are required" });
      }
      if (email !== expectedEmail || password !== expectedPassword) {
        return res.status(401).json({ error: "Invalid credentials" });
      }

      let user = await UserModel.findByEmail(expectedEmail);
      if (!user) {
        // Auto-reprovision after deletion (or first-time deploy without the
        // seed having run): create a bare reviewer user. They land in an
        // empty new-account state — supporting-cast / demo races are gone
        // until the seed is re-run, but the flow still works.
        user = await UserModel.create({
          appleId: REVIEWER_APPLE_ID,
          email: expectedEmail,
          name: REVIEWER_DISPLAY_NAME,
          displayName: REVIEWER_DISPLAY_NAME,
          // Hidden from real users (leaderboards, search, public races); the
          // reviewer still sees their own data via self-aware queries.
          isReviewAccount: true,
        });
      }

      const sessionToken = signToken({
        userId: user.id,
        appleId: user.appleId,
      });

      res.json({ user: withAdminFlag(user, checkAdmin), sessionToken });
    } catch (error) {
      console.error("Review auth error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.get("/me", requireAuth, async (req, res) => {
    try {
      const incomingFriendRequests = await getIncomingRequestCount(req.user.id);
      const heldCoins = await getHeldCoinsSafe(req.user.id);
      res.json({
        user: withAdminFlag(
          {
            ...req.user,
            // 1.1.4 compat: clients pre-step-goal-removal expect a non-null int.
            stepGoal: req.user.stepGoal ?? 5000,
            incomingFriendRequests,
            heldCoins,
          },
          checkAdmin
        ),
      });
    } catch (error) {
      console.error("Get me error:", error);
      res.json({ user: req.user });
    }
  });

  // 1.1.4 compat: step-goal endpoint was removed in 1.1.5. Old clients still
  // call this when the user opens profile. Accept and no-op so they don't 404.
  router.put("/me/step-goal", requireAuth, async (req, res) => {
    res.json({
      user: withAdminFlag(
        { ...req.user, stepGoal: req.user.stepGoal ?? 5000 },
        checkAdmin
      ),
    });
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

  router.put("/me/display-name", requireAuth, async (req, res) => {
    const { displayName } = req.body;

    if (displayName === undefined) {
      return res.status(400).json({ error: "displayName is required" });
    }

    if (displayName !== null) {
      const validation = validateDisplayName(displayName);
      if (!validation.isValid) {
        return res.status(400).json({ error: validation.error });
      }

      try {
        const updatedUser = await updateDisplayName({
          userId: req.user.id,
          displayName: validation.normalized,
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

  router.post("/me/profile-photo/upload-url", requireAuth, async (req, res) => {
    const { contentType } = req.body;

    if (contentType === undefined) {
      return res.status(400).json({ error: "contentType is required" });
    }

    if (
      typeof contentType !== "string" ||
      !ALLOWED_PROFILE_PHOTO_CONTENT_TYPES.includes(contentType)
    ) {
      return res.status(400).json({
        error:
          "contentType must be one of image/jpeg, image/png, image/heic, image/heif",
      });
    }

    try {
      const upload = await createProfilePhotoUpload({
        userId: req.user.id,
        contentType,
      });
      res.json({ upload });
    } catch (error) {
      console.error("Profile photo upload target error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.put("/me/profile-photo", requireAuth, async (req, res) => {
    const { key, url } = req.body;

    if (key === undefined) {
      return res.status(400).json({ error: "key is required" });
    }

    if (url === undefined) {
      return res.status(400).json({ error: "url is required" });
    }

    if (typeof key !== "string" || key.trim().length === 0) {
      return res.status(400).json({ error: "key is required" });
    }

    if (typeof url !== "string" || url.trim().length === 0) {
      return res.status(400).json({ error: "url is required" });
    }

    try {
      const user = await setProfilePhoto({
        userId: req.user.id,
        key: key.trim(),
        url: url.trim(),
      });
      res.json({ user });
    } catch (error) {
      if (error instanceof InvalidProfilePhotoError) {
        return res.status(400).json({ error: error.message });
      }

      console.error("Profile photo save error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.delete("/me/profile-photo", requireAuth, async (req, res) => {
    try {
      const user = await removeProfilePhoto({
        userId: req.user.id,
      });
      res.json({ user });
    } catch (error) {
      console.error("Profile photo delete error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.post("/me/profile-photo/prompt-dismiss", requireAuth, async (req, res) => {
    try {
      const user = await dismissProfilePhotoPrompt({
        userId: req.user.id,
      });
      res.json({ user });
    } catch (error) {
      console.error("Profile photo prompt dismiss error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.delete("/account", requireAuth, async (req, res) => {
    try {
      await deleteUserAccount({ userId: req.user.id });
      return res.status(204).send();
    } catch (error) {
      if (error instanceof DeleteUserAccountError) {
        return res
          .status(error.statusCode || 500)
          .json({ error: error.message });
      }
      console.error("Delete account error:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  router.get("/check-display-name", requireAuth, async (req, res) => {
    const { name } = req.query;

    if (!name || typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "name query parameter is required" });
    }

    const validation = validateDisplayName(name);
    if (!validation.isValid) {
      return res.json({ available: false, reason: validation.error });
    }

    const existing = await UserModel.findByDisplayNameInsensitive(
      validation.normalized,
      req.user.id
    );
    res.json({ available: !existing });
  });

  return router;
}

module.exports = { createAuthRouter, DISPLAY_NAME_MIN_LENGTH };
