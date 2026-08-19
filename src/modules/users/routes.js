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
const {
  setDisplayName: defaultSetDisplayName,
  buildSetDisplayName,
} = require("./commands/setDisplayName");
const {
  setDiscoverableName: defaultSetDiscoverableName,
  buildSetDiscoverableName,
} = require("./commands/setDiscoverableName");
const {
  serializeAuthenticatedUser,
} = require("./services/serializeAuthenticatedUser");
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
const {
  buildSeededRaceBuckets,
  SeededBucketError,
  supportsBuckets: supportsSeededRaceBuckets,
} = require("../races/services/seededRaceBuckets");
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
const {
  hashClientIp,
  hashClientNet,
  hmacClientIpHashes,
  hmacClientIpHashesForVersion,
} = require("../../shared/lib/clientIp");
const { appSettings: defaultAppSettings } = require("../../shared/config/appSettings");
const authMeCache = require("./services/authMeCache");
const { prisma } = require("../../db");
const { asyncHandler } = require("../../shared/http/asyncHandler");
const { ValidationError } = require("../../shared/errors/AppError");
const { buildSetLeaderboardVisibility } = require("./commands/setLeaderboardVisibility");
const {
  serializeAuthShellUser,
} = require("./services/serializeAuthShellUser");
const {
  isStrictFlagEnabled,
} = require("../../shared/config/isStrictFlagEnabled");

// Version-gated omission of `featureFlags.stepSampleBucketMinutes` (2026-07-23
// incident #2). Shared by `withRuntimeFlags` (which decides whether to emit the
// flag) and the C5 cache key (which must not serve a modern payload to a
// below-floor build) — ONE function so the two can never drift apart.
function isBelowFineBucketFloor(clientAppVersion) {
  return compareVersions(clientAppVersion, FINE_BUCKET_MIN_APP_VERSION) === -1;
}

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
  // Two-tier since the invite-code onboarding spec (part D): the exact IP hash
  // AND a coarser network-prefix hash. Both are computed from the same request;
  // the query decides which tier may answer. `signupId` is supplied by the
  // provisioner so the query can name the account in its [REFERRAL] log lines.
  const fallbackCodeFor = (req) => (signupId) => {
    const env = dependencies.env || process.env;
    const active = hmacClientIpHashes(req, {
      env,
      logger: dependencies.logger || console,
    });
    const previous = active.version > 1
      ? hmacClientIpHashesForVersion(req, active.version - 1, { env })
      : { ipHash: null, ipNetHash: null, version: null };
    return findLinkOpenCode({
      ipHash: active.ipHash,
      ipNetHash: active.ipNetHash,
      ipHashVersion: active.version,
      ipNetHashVersion: active.version,
      previousIpHash: previous.ipHash,
      previousIpNetHash: previous.ipNetHash,
      previousIpHashVersion: previous.version,
      previousIpNetHashVersion: previous.version,
      // Bounded legacy dual-read input; the query decides whether the 48-hour
      // compatibility interval is still open.
      legacyIpHash: hashClientIp(req),
      legacyIpNetHash: hashClientNet(req),
      signupId,
    });
  };
  const referralSourceRaceIdFor = async (token) => {
    if (typeof token !== "string" || !token) return null;
    try {
      const race = await prisma.race.findUnique({
        where: { shareToken: token },
        select: { id: true },
      });
      return race?.id || null;
    } catch {
      return null;
    }
  };
  const updateDisplayName =
    dependencies.setDisplayName ||
    (dependencies.User
      ? buildSetDisplayName(dependencies)
      : defaultSetDisplayName);
  const updateDiscoverableName =
    dependencies.setDiscoverableName ||
    (dependencies.User
      ? buildSetDiscoverableName(dependencies)
      : defaultSetDiscoverableName);
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
  const setLeaderboardVisibility = dependencies.setLeaderboardVisibility ||
    (dependencies.User
      ? async ({ userId, hidden }) => UserModel.update(userId, { hiddenFromLeaderboard: hidden })
      : buildSetLeaderboardVisibility(dependencies));
  const optUserIntoPendingSeededRaces =
    dependencies.optUserIntoPendingSeededRaces ||
    defaultOptUserIntoPendingSeededRaces;
  const appSettings = dependencies.appSettings || defaultAppSettings;
  const seededBuckets =
    dependencies.seededBuckets || buildSeededRaceBuckets(dependencies);

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
    const belowFineBucketFloor = isBelowFineBucketFloor(clientAppVersion);
    const stepSampleBucketMinutes = belowFineBucketFloor
      ? undefined
      : await safeNumber("stepSampleBucketMinutes", [5, 10, 15, 30, 60]);
    // Batch 2026-08-08 item 9: server-only bookkeeping columns. EVERY user
    // payload this router emits is built by spreading the raw `users` row
    // (`...req.user` in GET /auth/me, GET /auth/session, PUT /auth/me/step-goal,
    // and the ensure*User rows returned by the sign-in routes), so a new column
    // leaks into the API automatically unless it is stripped. Both are stripped
    // HERE — the single funnel every one of those responses passes through —
    // rather than at ~10 call sites.
    //
    // Removing never-before-present fields is safe for frozen clients: no
    // shipped build can read a key that has never existed. Keeping them out is
    // also load-bearing for `User.touchLastSeen`, which skips /auth/me cache
    // invalidation precisely because neither column is observable to a client.
    const clientSafeUser = serializeAuthenticatedUser(user);
    return {
      ...clientSafeUser,
      featureFlags: {
        bannerAdsEnabled: await safeFlag("bannerAdsEnabled", false),
        dualBoxBannersEnabled: await safeFlag("dualBoxBannersEnabled", false),
        teamRacesEnabled: await safeFlag("teamRacesEnabled", true),
        onboardingV2Enabled: await safeFlag("onboardingV2Enabled", false),
        // Additive (onboarding revamp §6.1). Ungated by app version: shipped
        // binaries read named keys and ignore unknown ones, so this cannot
        // change behavior for anyone until a v3-capable build reads it.
        onboardingV3Enabled: await safeFlag("onboardingV3Enabled", false),
        // Kill switch for the onboarding invite-code step. Defaults TRUE (see
        // KNOWN_FLAGS) — it fails open so a settings hiccup cannot silently
        // cost us referrals; flipping it false hides the step instantly across
        // every shipped build with no resubmission.
        onboardingInviteCodeEnabled: await safeFlag(
          "onboardingInviteCodeEnabled",
          true
        ),
        openUserRaceDiscoveryEnabled: await safeFlag(
          "openUserRaceDiscoveryEnabled",
          false
        ),
        quickCreateRaceCtaEnabled: await safeFlag(
          "quickCreateRaceCtaEnabled",
          false
        ),
        setupInviteCodePromptEnabled: await safeFlag(
          "setupInviteCodePromptEnabled",
          false
        ),
        // Custom race windows (spec §5.2a). Additive and ungated by app
        // version: frozen binaries read named keys off featureFlags and ignore
        // unknown ones. Fail-CLOSED (false) — the client must not offer a
        // control the backend will reject with 403 FEATURE_DISABLED.
        customRaceWindowEnabled: await safeFlag(
          "customRaceWindowEnabled",
          false
        ),
        racesInviteDecisionGateEnabled: await safeFlag(
          "racesInviteDecisionGateEnabled",
          false
        ),
        // Additive capability for Home's share-first quick-race CTA. This is
        // the same server-owned switch that gates transactional auto-friendship
        // on a share-token join, so clients never advertise behavior the
        // backend will not perform. Literal boolean, fail-closed, and inert for
        // frozen clients that ignore unknown featureFlags keys.
        quickRaceShareAutoFriendEnabled: await safeFlag(
          "quickRaceShareAutoFriendEnabled",
          false
        ),
        // Additive (batch 2026-08-09 item 9), same shape and same reasoning as
        // the v3 flag above: an unknown key is ignored by every shipped binary,
        // so serving it is inert until a mandatory-capable build reads it.
        // Default FALSE — the safe side, since `true` is what removes a user's
        // way out of the tutorial.
        tutorialMandatoryEnabled: await safeFlag(
          "tutorialMandatoryEnabled",
          false
        ),
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
      const {
        identityToken,
        userIdentifier,
        email,
        name,
        referralCode,
        referralSourceRaceToken,
      } = req.body;

      if (!identityToken) {
        return res.status(400).json({ error: "identityToken is required" });
      }

      const appleIdentity = await verifyIdentityToken(identityToken);

      if (userIdentifier && userIdentifier !== appleIdentity.sub) {
        return res.status(401).json({ error: "Apple user identifier does not match token subject" });
      }

      let metricsV2SignupEpochId = null;
      if (
        req.clientFeatures?.has("admin_metrics_v2") === true &&
        (await appSettings.getFlag("adminMetricsV2TelemetryEnabled")) === true
      ) {
        const epoch = await prisma.adminMetricsCollectionEpoch.findFirst({
          where: { endedAt: null },
          orderBy: { startedAt: "desc" },
          select: { id: true },
        });
        metricsV2SignupEpochId = epoch?.id || null;
      }

      const user = await provisionUser({
        appleId: appleIdentity.sub,
        email: email || appleIdentity.email,
        name,
        referralCode,
        referralSourceRaceId: referralCode
          ? await referralSourceRaceIdFor(referralSourceRaceToken)
          : null,
        fallbackReferralCode: fallbackCodeFor(req),
        ...(req.clientFeatures?.has("discoverable_identity") === true &&
        (await appSettings.getFlag(
          "discoverableIdentityOnboardingEnrollmentEnabled"
        )) === true
          ? { nameSetupOnboardingRequired: true }
          : {}),
        emitSignInEvent: true,
        ...(metricsV2SignupEpochId
          ? {
              metricsV2SignupEligible: true,
              metricsV2SignupEpochId,
            }
          : {}),
      });
      if (
        metricsV2SignupEpochId &&
        user.metricsV2EligibleEpochId !== metricsV2SignupEpochId
      ) {
        await prisma.user.updateMany({
          where: { id: user.id },
          data: {
            metricsV2EligibleAt: new Date(),
            metricsV2EligibleEpochId: metricsV2SignupEpochId,
          },
        });
      }

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
      const { idToken, email, name, referralCode, referralSourceRaceToken } = req.body;

      if (!idToken) {
        return res.status(400).json({ error: "idToken is required" });
      }

      const googleIdentity = await verifyGoogleToken(idToken);

      const user = await provisionGoogleUser({
        googleSub: googleIdentity.sub,
        email: email || googleIdentity.email,
        name,
        referralCode,
        referralSourceRaceId: referralCode
          ? await referralSourceRaceIdFor(referralSourceRaceToken)
          : null,
        fallbackReferralCode: fallbackCodeFor(req),
        ...(req.clientFeatures?.has("discoverable_identity") === true &&
        (await appSettings.getFlag(
          "discoverableIdentityOnboardingEnrollmentEnabled"
        )) === true
          ? { nameSetupOnboardingRequired: true }
          : {}),
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
      const compact =
        req.query.view === "shell-v1" &&
        (await isStrictFlagEnabled(appSettings, "apiAuthShellV1Enabled"));
      // The assembly this endpoint has always done: users row + a friendships
      // COUNT + a race_participants SUM + the app_settings flags.
      const assemble = async () => {
        const incomingFriendRequests = await getIncomingRequestCount(req.user.id);
        const heldCoins = await getHeldCoinsSafe(req.user.id);
        // Remote feature flags ride the /auth/me user payload (fetched at launch
        // and on resume). Additive: old clients ignore the key; getFlag never
        // throws (degrades to the flag's declared default).
        // Character powers were removed. Kept as a hard `false` (rather than
        // dropped) so a frozen 2.0.x client, which shows the home character-power
        // chip whenever this is true, reliably hides it against this backend.
        const characterPowersEnabled = false;
        return withRuntimeFlags(
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
        );
      };

      // C5 (spec §5 Phase E2): 10s read-through, keyed by user + the ONLY
      // request-varying input (the fine-bucket app-version gate). Every
      // read-back-after-write field invalidates at its write site — see the
      // classification table atop authMeCache.js. Flag off / Redis unavailable
      // => `assemble()` runs exactly as before.
      let cacheEnabled = false;
      try {
        cacheEnabled =
          (await appSettings.getFlag("redisCacheAuthMeEnabled")) === true;
      } catch {
        cacheEnabled = false;
      }
      const user = await authMeCache.read({
        userId: req.user.id,
        fineBucketVariant: isBelowFineBucketFloor(req.headers["x-app-version"]),
        contract: compact ? "shell-v1" : "legacy",
        enabled: cacheEnabled,
        load: assemble,
      });

      res.json(
        compact
          ? { contract: "auth-shell-v1", user: serializeAuthShellUser(user) }
          : { user }
      );
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
    const compact =
      req.query.view === "shell-v1" &&
      (await isStrictFlagEnabled(appSettings, "apiAuthShellV1Enabled"));
    const sessionToken = signToken({
      userId: req.user.id,
      appleId: req.user.appleId,
    });

    const [heldCoins, incomingFriendRequests] = await Promise.all([
      getHeldCoinsSafe(req.user.id),
      compact ? getIncomingRequestCount(req.user.id) : Promise.resolve(undefined),
    ]);
    const user = await withRuntimeFlags(
      withAdminFlag(
        {
          ...req.user,
          heldCoins,
          ...(compact
            ? {
                incomingFriendRequests,
                characterPowersEnabled: false,
                hiddenFromLeaderboard:
                  req.user.hiddenFromLeaderboard ?? false,
                autoJoinFeaturedRaces:
                  req.user.autoJoinFeaturedRaces ?? false,
              }
            : {}),
        },
        checkAdmin
      ),
      req.headers["x-app-version"]
    );
    res.json(
      compact
        ? {
            contract: "auth-shell-v1",
            sessionToken,
            user: serializeAuthShellUser(user),
          }
        : { sessionToken, user }
    );
  });

  router.put(
    "/me/discoverable-name",
    requireAuth,
    asyncHandler(async (req, res) => {
      const { firstName, lastName } = req.body || {};
      const result = await updateDiscoverableName({
        userId: req.user.id,
        firstName,
        lastName,
      });
      res.json({
        user: await withRuntimeFlags(
          result.user,
          req.headers["x-app-version"]
        ),
        suggestedDisplayName: result.suggestedDisplayName,
      });
    })
  );

  router.put("/me/display-name", requireAuth, async (req, res) => {
    const { displayName, completeDiscoverableNameSetup } = req.body || {};

    if (
      completeDiscoverableNameSetup !== undefined &&
      typeof completeDiscoverableNameSetup !== "boolean"
    ) {
      return res.status(400).json({
        error: "completeDiscoverableNameSetup must be a boolean",
        code: "INVALID_DISCOVERABLE_SETUP_FLAG",
      });
    }

    if (displayName === undefined) {
      return res.status(400).json({ error: "displayName is required" });
    }
    if (displayName === null && completeDiscoverableNameSetup === true) {
      return res.status(400).json({
        error: "Display name must be a non-empty string or null",
      });
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
          ...(completeDiscoverableNameSetup !== undefined
            ? { completeDiscoverableNameSetup }
            : {}),
        });

        return res.json({ user: await withRuntimeFlags(updatedUser, req.headers["x-app-version"]) });
      } catch (error) {
        if (error.name === "DisplayNameTakenError") {
          return res.status(409).json({
            error: error.message,
            ...(completeDiscoverableNameSetup === true
              ? {
                  code: "DISPLAY_NAME_TAKEN",
                  suggestedDisplayName: error.suggestedDisplayName,
                }
              : {}),
          });
        }
        if (error instanceof ValidationError) {
          return res.status(error.statusCode).json({
            error: error.message,
            code: error.code,
          });
        }
        console.error("Display name error:", error);
        return res.status(500).json({ error: "Internal server error" });
      }
    }

    try {
      const updatedUser = await updateDisplayName({
        userId: req.user.id,
        displayName: null,
        ...(completeDiscoverableNameSetup !== undefined
          ? { completeDiscoverableNameSetup }
          : {}),
      });

      res.json({ user: await withRuntimeFlags(updatedUser, req.headers["x-app-version"]) });
    } catch (error) {
      if (error.name === "DisplayNameTakenError") {
        return res.status(409).json({
          error: error.message,
          ...(completeDiscoverableNameSetup === true
            ? {
                code: "DISPLAY_NAME_TAKEN",
                suggestedDisplayName: error.suggestedDisplayName,
              }
            : {}),
        });
      }
      if (error instanceof ValidationError) {
        return res.status(error.statusCode).json({
          error: error.message,
          code: error.code,
        });
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
      const user = await setLeaderboardVisibility({ userId: req.user.id, hidden });
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
          // Capability is durable account state, not a one-request header:
          // a tokenless settings request after an upgrade must still choose
          // the private stream of an already-stamped BUCKET window.
          const storedFeatures = new Set(user.clientFeatures || req.user.clientFeatures || []);
          if (supportsSeededRaceBuckets(storedFeatures)) {
            for (const seedKind of ["DAILY_10K", "WEEKLY_50K"]) {
              try {
                await seededBuckets.elect({
                  userId: req.user.id,
                  seedKind,
                  window: "UPCOMING",
                });
              } catch (error) {
                // LEGACY/missing windows retain the legacy enrollment below;
                // the preference write itself remains best-effort as it has
                // always been.
                if (!(error instanceof SeededBucketError) || ![
                  "SEED_NOT_FOUND_OR_DISABLED", "MATCHING_UNAVAILABLE",
                ].includes(error.code)) {
                  throw error;
                }
              }
            }
          }
          // This command consults the stamped mode and excludes capable users
          // only from BUCKET windows, so it fills every applicable LEGACY row
          // without relying on the current request token or live flag.
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
