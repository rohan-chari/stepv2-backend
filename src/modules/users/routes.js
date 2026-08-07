const { Router } = require("express");
const { compareVersions } = require("../../utils/appVersion");
const FINE_BUCKET_MIN_APP_VERSION = process.env.FINE_BUCKET_MIN_APP_VERSION || "1.7.1";
const {
  AppleIdentityTokenError,
  verifyAppleIdentityToken,
} = require("./services/appleIdentityToken");
const { ensureAppleUser } = require("./services/ensureAppleUser");
const {
  GoogleIdentityTokenError,
  verifyGoogleIdentityToken,
} = require("./services/googleIdentityToken");
const { ensureGoogleUser } = require("./services/ensureGoogleUser");
const { buildRequireAuth } = require("../../middleware/requireAuth");
const { signSessionToken: defaultSignSessionToken } = require("./services/sessionToken");
const { setDisplayName: defaultSetDisplayName } = require("./commands/setDisplayName");
const {
  InvalidProfilePhotoError,
  buildCreateProfilePhotoUpload,
  buildSetProfilePhoto,
  buildRemoveProfilePhoto,
  buildDismissProfilePhotoPrompt,
} = require("./commands/profilePhoto");
const {
  buildRecordRenameChipShown,
  buildDismissRenameChip,
} = require("./commands/renameChip");
const {
  deleteUserAccount: defaultDeleteUserAccount,
  DeleteUserAccountError,
} = require("./commands/deleteUserAccount");
const { getIncomingFriendRequestCount: defaultGetIncomingFriendRequestCount } = require("../social/queries/getFriends");
const {
  optUserIntoPendingSeededRaces: defaultOptUserIntoPendingSeededRaces,
} = require("../races/commands/autoJoinFeaturedRaces");
const { User: DefaultUser } = require("./models/user");
const {
  ALLOWED_PROFILE_PHOTO_CONTENT_TYPES,
} = require("./services/profilePhotoStorage");

const {
  validateDisplayName,
  DISPLAY_NAME_MIN_LENGTH,
} = require("../../shared/lib/displayNameValidator");
const { isAdminUser, withAdminFlag } = require("../admin");
const {
  findLinkOpenReferralCode: defaultFindLinkOpenReferralCode,
} = require("../social/queries/findLinkOpenReferralCode");
const { hashClientIp } = require("../../shared/lib/clientIp");
const { appSettings: defaultAppSettings } = require("../../shared/config/appSettings");

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
  const verifyGoogleToken =
    dependencies.verifyGoogleIdentityToken || verifyGoogleIdentityToken;
  const provisionGoogleUser = dependencies.ensureGoogleUser || ensureGoogleUser;
  const requireAuth =
    dependencies.requireAuth || buildRequireAuth(dependencies);
  const signToken = dependencies.signSessionToken || defaultSignSessionToken;
  const findLinkOpenCode =
    dependencies.findLinkOpenReferralCode || defaultFindLinkOpenReferralCode;
  // IP-correlated attribution fallback (create branch only, inside ensure*):
  // when the provision body has no referralCode, match the signup IP against
  // recent referral landing-page opens. Thunked so the lookup only runs for
  // genuinely new users.
  const fallbackCodeFor = (req) => () =>
    findLinkOpenCode({ ipHash: hashClientIp(req) });
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
  const recordRenameChipShown =
    dependencies.recordRenameChipShown ||
    buildRecordRenameChipShown(dependencies);
  const dismissRenameChip =
    dependencies.dismissRenameChip || buildDismissRenameChip(dependencies);
  const getIncomingRequestCount = dependencies.getIncomingFriendRequestCount || defaultGetIncomingFriendRequestCount;
  const deleteUserAccount =
    dependencies.deleteUserAccount || defaultDeleteUserAccount;
  const checkAdmin = dependencies.isAdminUser || isAdminUser;
  const UserModel = dependencies.User || DefaultUser;
  const optUserIntoPendingSeededRaces =
    dependencies.optUserIntoPendingSeededRaces ||
    defaultOptUserIntoPendingSeededRaces;
  const appSettings = dependencies.appSettings || defaultAppSettings;

  async function withRuntimeFlags(user, clientAppVersion) {
    // Additive nested data: old clients ignore it. Resolve each value
    // defensively because tests, rolling deploys, or an older settings service
    // may not yet know the new key.
    const safeFlag = async (key, fallback) => {
      try {
        const value = await appSettings.getFlag(key);
        return typeof value === "boolean" ? value : fallback;
      } catch {
        return fallback;
      }
    };
    // Numeric feature flag (Five-Minute Step Samples §3.2). Returns the stored
    // value only when it is an integer in `allowed`; anything else (absent, null,
    // non-numeric, out-of-set, or a missing getRawFlag on an older settings
    // service) yields undefined so the key is OMITTED and the client defaults to
    // its own hourly fallback.
    const safeNumber = async (key, allowed) => {
      try {
        if (typeof appSettings.getRawFlag !== "function") return undefined;
        const value = await appSettings.getRawFlag(key);
        const num = typeof value === "number" ? value : Number(value);
        return Number.isInteger(num) && allowed.includes(num) ? num : undefined;
      } catch {
        return undefined;
      }
    };
    // Version-gated (2026-07-23 incident #2): builds 1.6.9–1.7.0 carry the
    // fine-grained reader but inflate fine buckets; 1.7.1 ships the
    // normalization fix. Omit the flag below the floor so buggy readers stay
    // hourly. Fail OPEN on absent/garbled versions (compareVersions → null):
    // builds that old predate the reader and ignore the flag entirely.
    const belowFineBucketFloor =
      compareVersions(clientAppVersion, FINE_BUCKET_MIN_APP_VERSION) === -1;
    const stepSampleBucketMinutes = belowFineBucketFloor
      ? undefined
      : await safeNumber("stepSampleBucketMinutes", [5, 10, 15, 30, 60]);
    return {
      ...user,
      featureFlags: {
        bannerAdsEnabled: await safeFlag("bannerAdsEnabled", false),
        dualBoxBannersEnabled: await safeFlag("dualBoxBannersEnabled", false),
        teamRacesEnabled: await safeFlag("teamRacesEnabled", true),
        onboardingV2Enabled: await safeFlag("onboardingV2Enabled", false),
        // Additive (onboarding revamp §6.1). Ungated by app version: shipped
        // binaries read named keys and ignore unknown ones, so this cannot
        // change behavior for anyone until a v3-capable build reads it.
        onboardingV3Enabled: await safeFlag("onboardingV3Enabled", false),
        ...(stepSampleBucketMinutes !== undefined
          ? { stepSampleBucketMinutes }
          : {}),
      },
    };
  }

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
  // Body: { identityToken, userIdentifier?, email?, name?, referralCode? }
  // referralCode is additive/optional — older app binaries never send it and
  // older backends ignored it, so it's safe both ways (CLAUDE.md old-client rule).
  router.post("/apple", async (req, res) => {
    try {
      const { identityToken, userIdentifier, email, name, referralCode } =
        req.body;

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
        referralCode,
        fallbackReferralCode: fallbackCodeFor(req),
        emitSignInEvent: true,
      });

      const sessionToken = signToken({
        userId: user.id,
        appleId: appleIdentity.sub,
      });

      res.json({
        user: await withRuntimeFlags(withAdminFlag(user, checkAdmin), req.headers["x-app-version"]),
        sessionToken,
      });
    } catch (error) {
      if (error instanceof AppleIdentityTokenError) {
        return res.status(401).json({ error: error.message });
      }

      console.error("Auth error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /auth/google
  // Body: { idToken, email?, name?, referralCode? }
  // Android sign-in. Verifies the Google ID token, keys the account on the
  // verified Google `sub` (User.googleSub), and returns the same
  // { user, sessionToken } envelope as /auth/apple. Independent of Apple
  // accounts — never linked by email. See ANDROID.md §G1. referralCode is
  // additive/optional (old clients omit it; old backends ignored it).
  router.post("/google", async (req, res) => {
    try {
      const { idToken, email, name, referralCode } = req.body;

      if (!idToken) {
        return res.status(400).json({ error: "idToken is required" });
      }

      const googleIdentity = await verifyGoogleToken(idToken);

      const user = await provisionGoogleUser({
        googleSub: googleIdentity.sub,
        email: email || googleIdentity.email,
        name,
        referralCode,
        fallbackReferralCode: fallbackCodeFor(req),
        emitSignInEvent: true,
      });

      const sessionToken = signToken({
        userId: user.id,
        appleId: user.appleId,
      });

      res.json({
        user: await withRuntimeFlags(withAdminFlag(user, checkAdmin), req.headers["x-app-version"]),
        sessionToken,
      });
    } catch (error) {
      if (error instanceof GoogleIdentityTokenError) {
        return res.status(401).json({ error: error.message });
      }

      console.error("Google auth error:", error);
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

      res.json({
        user: await withRuntimeFlags(withAdminFlag(user, checkAdmin), req.headers["x-app-version"]),
        sessionToken,
      });
    } catch (error) {
      console.error("Review auth error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.get("/me", requireAuth, async (req, res) => {
    try {
      const incomingFriendRequests = await getIncomingRequestCount(req.user.id);
      const heldCoins = await getHeldCoinsSafe(req.user.id);
      // Remote feature flags ride the /auth/me user payload (fetched at launch
      // and on resume). Additive: old clients ignore the key; getFlag never
      // throws (degrades to the flag's declared default).
      // Character powers were removed. Kept as a hard `false` (rather than
      // dropped) so a frozen 2.0.x client, which shows the home character-power
      // chip whenever this is true, reliably hides it against this backend.
      const characterPowersEnabled = false;
      res.json({
        user: await withRuntimeFlags(
          withAdminFlag(
            {
              ...req.user,
              characterPowersEnabled,
              // 1.1.4 compat: clients pre-step-goal-removal expect a non-null int.
              stepGoal: req.user.stepGoal ?? 5000,
              // T8: surface the global-leaderboard opt-out so clients can render
              // the toggle. Default false when the column is absent (older row /
              // backend version) — defensive read, never null.
              hiddenFromLeaderboard: req.user.hiddenFromLeaderboard ?? false,
              // Auto-join daily/weekly featured challenges toggle. Same
              // defensive-default story as hiddenFromLeaderboard.
              autoJoinFeaturedRaces: req.user.autoJoinFeaturedRaces ?? false,
              incomingFriendRequests,
              heldCoins,
            },
            checkAdmin
          ),
          req.headers["x-app-version"]
        ),
      });
    } catch (error) {
      console.error("Get me error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // 1.1.4 compat: step-goal endpoint was removed in 1.1.5. Old clients still
  // call this when the user opens profile. Accept and no-op so they don't 404.
  router.put("/me/step-goal", requireAuth, async (req, res) => {
    res.json({
      user: await withRuntimeFlags(
        withAdminFlag(
          { ...req.user, stepGoal: req.user.stepGoal ?? 5000 },
          checkAdmin
        ),
        req.headers["x-app-version"]
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
      user: await withRuntimeFlags(
        withAdminFlag({ ...req.user, heldCoins }, checkAdmin),
        req.headers["x-app-version"]
      ),
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

        return res.json({ user: await withRuntimeFlags(updatedUser, req.headers["x-app-version"]) });
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

      res.json({ user: await withRuntimeFlags(updatedUser, req.headers["x-app-version"]) });
    } catch (error) {
      if (error.name === "DisplayNameTakenError") {
        return res.status(409).json({ error: error.message });
      }
      console.error("Display name error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // T8: global-leaderboard opt-out. Body { hidden: <bool> }. Additive endpoint;
  // older clients never call it. Persists hiddenFromLeaderboard and echoes the
  // updated user. The user is still visible to friends and still sees their own
  // global rank (see getLeaderboard) — this only hides them from strangers'
  // global board.
  router.put("/me/leaderboard-visibility", requireAuth, async (req, res) => {
    const { hidden } = req.body || {};

    if (typeof hidden !== "boolean") {
      return res.status(400).json({ error: "hidden must be a boolean" });
    }

    try {
      const user = await UserModel.update(req.user.id, {
        hiddenFromLeaderboard: hidden,
      });
      return res.json({ user: await withRuntimeFlags(user, req.headers["x-app-version"]) });
    } catch (error) {
      console.error("Leaderboard visibility error:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  // Auto-join daily/weekly featured challenges. Body { enabled: <bool> }.
  // Additive endpoint; older clients never call it. Persists
  // autoJoinFeaturedRaces and echoes the updated user. Enabling also opts the
  // user into the already-created PENDING "next" seeded race(s) right away —
  // best-effort, so a race hiccup never fails the settings write — while the
  // renewal cron handles every future race (src/jobs/seededRaceRenewal.js).
  router.put("/me/featured-auto-join", requireAuth, async (req, res) => {
    const { enabled } = req.body || {};

    if (typeof enabled !== "boolean") {
      return res.status(400).json({ error: "enabled must be a boolean" });
    }

    try {
      const user = await UserModel.update(req.user.id, {
        autoJoinFeaturedRaces: enabled,
      });
      if (enabled) {
        try {
          await optUserIntoPendingSeededRaces(req.user.id);
        } catch (error) {
          console.error("Featured auto-join opt-in error:", error);
        }
      }
      return res.json({ user: await withRuntimeFlags(user, req.headers["x-app-version"]) });
    } catch (error) {
      console.error("Featured auto-join error:", error);
      return res.status(500).json({ error: "Internal server error" });
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
      res.json({ user: await withRuntimeFlags(user, req.headers["x-app-version"]) });
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
      res.json({ user: await withRuntimeFlags(user, req.headers["x-app-version"]) });
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
      res.json({ user: await withRuntimeFlags(user, req.headers["x-app-version"]) });
    } catch (error) {
      console.error("Profile photo prompt dismiss error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /auth/me/rename-chip/shown
  // Body: {} (empty)
  // Records one impression of the home SETUP rename chip on the ACCOUNT, so the
  // nudge doesn't restart after a sign-out/sign-in (it used to live in
  // device-scoped SharedPreferences). Not idempotent by design — the client
  // guarantees at-most-once per app session — but the count is clamped, and the
  // increment is a no-op once the chip has been dismissed. Additive: no shipped
  // app version calls this, and an old client that never does is unaffected.
  router.post("/me/rename-chip/shown", requireAuth, async (req, res) => {
    try {
      const user = await recordRenameChipShown({ userId: req.user.id });
      res.json({ user: await withRuntimeFlags(user, req.headers["x-app-version"]) });
    } catch (error) {
      console.error("Rename chip shown error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /auth/me/rename-chip/dismiss
  // Body: {} (empty)
  // Retires the rename chip for this account. Idempotent: a second call returns
  // the existing timestamp unchanged.
  router.post("/me/rename-chip/dismiss", requireAuth, async (req, res) => {
    try {
      const user = await dismissRenameChip({ userId: req.user.id });
      res.json({ user: await withRuntimeFlags(user, req.headers["x-app-version"]) });
    } catch (error) {
      console.error("Rename chip dismiss error:", error);
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
