const path = require("path");
const cors = require("cors");
const express = require("express");
const compression = require("compression");

const { createAuthRouter } = require("./modules/users");
const { createStepsRouter } = require("./modules/steps");
const { createFriendsRouter } = require("./modules/social");
const { createAdminRouter } = require("./modules/admin");
const { createNotificationsRouter } = require("./modules/notifications");
const { createLeaderboardRouter } = require("./modules/leaderboard");
const { createRankedRouter } = require("./modules/ranked");
const { createRacesRouter } = require("./modules/races");
const { createTournamentsRouter } = require("./modules/tournaments");
const { createReferralsRouter } = require("./modules/social");
const { createShopRouter } = require("./routes/shop");
const { createPowerupsRouter } = require("./modules/powerups");
const { createDailyRewardRouter } = require("./modules/economy");
const { createCoinsRouter } = require("./modules/economy");
const { createStepMilestonesRouter } = require("./modules/steps");
const { createTutorialRouter } = require("./routes/tutorial");
const { createOnboardingRouter } = require("./routes/onboarding");
const { createAnalyticsRouter } = require("./modules/analytics");
const { createHomeRouter } = require("./modules/home");
const { createAppVersionRouter } = require("./routes/appVersion");
const { createAdsRouter } = require("./modules/economy");
const { extractTimezone } = require("./middleware/extractTimezone");
const { extractClientFeatures } = require("./shared/middleware/clientFeatures");
const { extractReleaseChannel } = require("./shared/middleware/releaseChannel");
const {
  buildAppleAppSiteAssociation,
  buildAssetLinks,
  renderRaceLandingPage,
  renderRaceNotFoundPage,
  renderReferralLandingPage,
  renderReferralNotFoundPage,
  renderTournamentLandingPage,
  renderTournamentNotFoundPage,
  sharing,
} = require("./modules/web");
const {
  getSharedRacePreview: defaultGetSharedRacePreview,
} = require("./modules/races");
const {
  getReferralPreview: defaultGetReferralPreview,
} = require("./modules/social");
const {
  looksLikeReferralCode,
  normalizeReferralCode,
} = require("./shared/lib/referralCode");
const { prisma: defaultPrisma } = require("./db");
const { errorMiddleware } = require("./shared/http/errorMiddleware");

function createApp(dependencies = {}) {
  const app = express();

  app.use(cors());
  // Phase B7 gzip-only contract: newer `compression` will negotiate Brotli when a
  // client offers `br`, but the spec pins the client contract to gzip only. Strip
  // any `br` token from Accept-Encoding before compression negotiates, so it never
  // selects Brotli (falls back to gzip, or identity if the client offered br
  // alone). Deflate is left intact but gzip wins for every real client.
  app.use((req, _res, next) => {
    const ae = req.headers["accept-encoding"];
    if (typeof ae === "string" && /\bbr\b/i.test(ae)) {
      const kept = ae
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t && !/^br\s*(;|$)/i.test(t));
      req.headers["accept-encoding"] = kept.length ? kept.join(", ") : "identity";
    }
    next();
  });
  // gzip compression for compressible responses above 1 KiB. The `compression`
  // middleware preserves the decoded body/status byte-for-byte and sets
  // `Vary: Accept-Encoding` so caches key on it. Old and new apps decode
  // transparently (Dart HttpClient autoUncompress; undici/URLSession likewise).
  // Placed early so it wraps every downstream JSON response.
  app.use(compression({ threshold: 1024 }));
  app.use(express.json());
  app.use(extractTimezone);
  // Capability gating (X-Client-Features) is read app-wide: social surfaces
  // (races, friends, leaderboard, ranked, home) tailor character data to what
  // the client can render, not just the shop.
  app.use(extractClientFeatures);
  // Batch 2026-07-26, item 8: stamp req.releaseChannel on EVERY request (it was
  // previously mounted only on the shop + daily-reward routers), so the race,
  // home, leaderboard, friends and tournament surfaces can present test-only
  // characters to TestFlight viewers. Prod is the default for anything that
  // omits the header, so no shipped binary sees an asset it lacks.
  app.use(extractReleaseChannel);

  app.use("/auth", createAuthRouter(dependencies));
  app.use("/steps", createStepsRouter(dependencies));
  app.use("/friends", createFriendsRouter(dependencies));
  app.use("/admin", createAdminRouter(dependencies));
  app.use("/notifications", createNotificationsRouter(dependencies));
  app.use("/leaderboard", createLeaderboardRouter(dependencies));
  app.use("/ranked", createRankedRouter(dependencies));
  app.use("/races", createRacesRouter(dependencies));
  app.use("/tournaments", createTournamentsRouter(dependencies));
  app.use("/referrals", createReferralsRouter(dependencies));
  app.use("/shop", createShopRouter(dependencies));
  app.use("/powerups", createPowerupsRouter(dependencies));
  app.use("/daily-reward", createDailyRewardRouter(dependencies));
  app.use("/coins", createCoinsRouter(dependencies));
  app.use(
    "/users/me/step-milestones",
    createStepMilestonesRouter(dependencies)
  );
  app.use("/tutorial", createTutorialRouter(dependencies));
  app.use("/onboarding", createOnboardingRouter(dependencies));
  app.use("/analytics", createAnalyticsRouter(dependencies));
  app.use("/home", createHomeRouter(dependencies));
  app.use("/app-version", createAppVersionRouter(dependencies));
  // Unauthenticated by design: Google's AdMob SSV callback, trusted via its
  // ECDSA signature (see modules/economy/routes/ads.js).
  app.use("/ads", createAdsRouter(dependencies));

  app.get("/health", (req, res) => {
    res.json({ status: "ok" });
  });

  // ---- Shareable race links (deep-link verification + web landing page) ----
  const getSharedRacePreview =
    dependencies.getSharedRacePreview || defaultGetSharedRacePreview;
  const getReferralPreview =
    dependencies.getReferralPreview || defaultGetReferralPreview;

  // iOS Universal Link verification. Must be served at this exact path as
  // application/json with NO file extension. Static (no per-request data).
  app.get("/.well-known/apple-app-site-association", (req, res) => {
    res.type("application/json").send(JSON.stringify(buildAppleAppSiteAssociation()));
  });

  // Android App Link verification.
  app.get("/.well-known/assetlinks.json", (req, res) => {
    res.json(buildAssetLinks());
  });

  // Public web landing page for a shared race. Opened only when the app is NOT
  // installed (otherwise the OS routes the universal/app link into the app).
  const linkOpenDb = dependencies.prisma || defaultPrisma;
  // Top-of-funnel tap logging: one link_opens row per landing-page view.
  // Fire-and-forget — a logging failure must never affect the page render.
  function logLinkOpen(kind, code) {
    linkOpenDb.linkOpen
      .create({ data: { kind, code: code || null } })
      .catch(() => {});
  }

  app.get("/r/:token", async (req, res) => {
    const token = req.params.token;

    // Referral codes share the /r/* namespace with race share tokens; the
    // reserved BARA- prefix disambiguates (race tokens are hyphen-free, so they
    // never match). A prefixed-but-malformed token still renders the referral
    // not-found page rather than being mistaken for a race.
    if (looksLikeReferralCode(token)) {
      const code = normalizeReferralCode(token);
      const refLinks = {
        inviteUrl: sharing.buildShareUrl(code || token),
        appDeepLink: sharing.buildAppDeepLink(code || token),
        appStoreUrl: sharing.APP_STORE_URL,
        // Bake the code into the Play URL so Play Install Referrer attributes
        // Android installs deterministically (no clipboard needed).
        playStoreUrl: code
          ? `${sharing.PLAY_STORE_URL}&referrer=${encodeURIComponent(code)}`
          : sharing.PLAY_STORE_URL,
        ogImageUrl: sharing.OG_IMAGE_URL,
      };
      if (!code) {
        return res
          .status(404)
          .type("html")
          .send(renderReferralNotFoundPage(refLinks));
      }
      logLinkOpen("referral", code);
      try {
        const preview = await getReferralPreview({ code });
        if (!preview) {
          return res
            .status(404)
            .type("html")
            .send(renderReferralNotFoundPage(refLinks));
        }
        return res
          .type("html")
          .send(renderReferralLandingPage(preview, refLinks));
      } catch (error) {
        console.error("Referral landing page error:", error);
        return res
          .status(200)
          .type("html")
          .send(renderReferralNotFoundPage(refLinks));
      }
    }

    const links = {
      shareUrl: sharing.buildShareUrl(token),
      appDeepLink: sharing.buildAppDeepLink(token),
      appStoreUrl: sharing.APP_STORE_URL,
      playStoreUrl: sharing.PLAY_STORE_URL,
      ogImageUrl: sharing.OG_IMAGE_URL,
    };
    logLinkOpen("race_share", token);
    try {
      const preview = await getSharedRacePreview({ token: req.params.token });
      if (!preview) {
        return res.status(404).type("html").send(renderRaceNotFoundPage(links));
      }
      res.type("html").send(renderRaceLandingPage(preview, links));
    } catch (error) {
      console.error("Race landing page error:", error);
      // Degrade to the generic install page rather than a 500 — the link should
      // still get a non-installer to the store.
      res.status(200).type("html").send(renderRaceNotFoundPage(links));
    }
  });

  // Public web landing page for a shared tournament (Item 4). Uses a DEDICATED
  // tournament renderer (not the race one) so the fallback shows bracket copy +
  // the tournament custom-scheme deep link (bara://tournament/<token>).
  const getSharedTournamentPreview =
    dependencies.getSharedTournamentPreview ||
    require("./modules/tournaments/queries/getSharedTournamentPreview").getSharedTournamentPreview;
  app.get("/t/:token", async (req, res) => {
    const token = req.params.token;
    const links = {
      shareUrl: sharing.buildTournamentShareUrl(token),
      appDeepLink: sharing.buildTournamentAppDeepLink(token),
      appStoreUrl: sharing.APP_STORE_URL,
      playStoreUrl: sharing.PLAY_STORE_URL,
      ogImageUrl: sharing.OG_IMAGE_URL,
    };
    logLinkOpen("tournament_share", token);
    try {
      const preview = await getSharedTournamentPreview({ token });
      if (!preview) {
        return res
          .status(404)
          .type("html")
          .send(renderTournamentNotFoundPage(links));
      }
      res.type("html").send(renderTournamentLandingPage(preview, links));
    } catch (error) {
      console.error("Tournament landing page error:", error);
      res
        .status(200)
        .type("html")
        .send(renderTournamentNotFoundPage(links));
    }
  });

  // JSON body-parser error handler (§6.4 / Phase A5). An oversized body makes
  // express.json throw `entity.too.large`; without this, Express answers with its
  // default HTML 413. Return the JSON 413 contract instead so clients (notably
  // POST /steps/sync-v2) get a consistent machine-readable response. Only
  // entity.too.large is handled here; every other error passes through unchanged,
  // so normal-size JSON routes are byte-for-byte identical.
  app.use((err, req, res, next) => {
    if (
      err &&
      (err.type === "entity.too.large" || err.statusCode === 413 || err.status === 413)
    ) {
      return res.status(413).json({
        error: "Step sync request too large",
        code: "STEP_SYNC_TOO_LARGE",
      });
    }
    return next(err);
  });

  const publicDir = path.join(__dirname, "..", "public");
  app.get("/", (req, res) => res.sendFile(path.join(publicDir, "index.html")));
  app.get("/support", (req, res) => res.sendFile(path.join(publicDir, "support.html")));
  app.get("/support.html", (req, res) => res.sendFile(path.join(publicDir, "support.html")));
  app.get("/privacy", (req, res) => res.sendFile(path.join(publicDir, "privacy.html")));
  app.get("/privacy.html", (req, res) => res.sendFile(path.join(publicDir, "privacy.html")));
  // Bundled share-card image for link previews (point OG_IMAGE_URL at this).
  // 404s harmlessly until a public/share-card.png is added.
  app.get("/share-card.png", (req, res) =>
    res.sendFile(path.join(publicDir, "share-card.png"))
  );
  // AdMob app-ads.txt verification. Crawled by Google at the domain listed as
  // the app's developer website on the store listings; must be text/plain at
  // exactly this path. One file covers every app on this domain.
  app.get("/app-ads.txt", (req, res) =>
    res.type("text/plain").sendFile(path.join(publicDir, "app-ads.txt"))
  );

  // Central error handler — must be mounted LAST so every route/middleware
  // above can rely on next(err) (see shared/http/errorMiddleware.js).
  app.use(errorMiddleware);

  return app;
}

module.exports = { createApp };
