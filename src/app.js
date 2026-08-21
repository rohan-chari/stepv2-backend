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
const { createShopBootstrapRouter } = require("./modules/shop");
const { createPowerupsRouter } = require("./modules/powerups");
const { createDailyRewardRouter } = require("./modules/economy");
const { createCoinsRouter } = require("./modules/economy");
const { createStepMilestonesRouter } = require("./modules/steps");
const { createTutorialRouter } = require("./routes/tutorial");
const { createOnboardingRouter } = require("./routes/onboarding");
const { createAnalyticsRouter } = require("./modules/analytics");
const { createFeedbackRouter } = require("./modules/feedback");
const { createHomeRouter } = require("./modules/home");
const { createInboxRouter } = require("./modules/inbox");
const { createAppVersionRouter } = require("./routes/appVersion");
const { createAssetsRouter } = require("./routes/assets");
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
  createWaitlistRouter,
  createReviewsRouter,
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
const { hmacClientIpHashes } = require("./shared/lib/clientIp");
const { prisma: defaultPrisma, getDbPoolPressure } = require("./db");
const redisCache = require("./shared/cache/redisCache");
const { errorMiddleware } = require("./shared/http/errorMiddleware");
const { createApiContractTelemetry } = require("./shared/http/apiContractTelemetry");
const {
  createCapacityPhaseMetricsMiddleware,
} = require("./shared/observability/capacityPhaseMetrics");
const { appSettings } = require("./shared/config/appSettings");

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
  app.use(
    createApiContractTelemetry({ logger: dependencies.logger || console })
  );
  app.use(
    createCapacityPhaseMetricsMiddleware({
      settings: dependencies.appSettings || appSettings,
      logger: dependencies.logger || console,
      random: dependencies.capacityMetricsRandom || Math.random,
      env: dependencies.capacityMetricsEnv || process.env,
      readDbPoolPressure:
        dependencies.getDbPoolPressure || getDbPoolPressure,
    })
  );

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
  app.use("/shop", createShopBootstrapRouter(dependencies));
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
  app.use("/feedback", createFeedbackRouter(dependencies));
  app.use("/home", createHomeRouter(dependencies));
  app.use("/inbox", createInboxRouter(dependencies));
  app.use("/app-version", createAppVersionRouter(dependencies));
  // Unauthenticated by design: Google's AdMob SSV callback, trusted via its
  // ECDSA signature (see modules/economy/routes/ads.js).
  app.use("/ads", createAdsRouter(dependencies));

  // `redis` is additive and internal-only (spec §3): old clients ignore it, and
  // `status` keeps its exact previous meaning/value. "disabled" = REDIS_URL
  // unset (cache inert), "down" = configured but unreachable — never a 500.
  app.get("/health", async (req, res) => {
    let redis = "disabled";
    try {
      redis = await redisCache.healthStatus();
    } catch {
      redis = "down";
    }
    const response = { status: "ok", redis };
    if (process.env.CAPACITY_MODE === "true" || process.env.CAPACITY_MODE === "1") {
      response.capacity = {
        dbPool: getDbPoolPressure(),
        memory: process.memoryUsage(),
        cpu: process.cpuUsage(),
      };
    }
    res.json(response);
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
  // ipHash (never the raw IP) powers the referral-attribution fallback: a
  // codeless signup from the same IP shortly after an open attributes to the
  // opened code (see findLinkOpenReferralCode.js).
  function logLinkOpen(kind, code, req, sourceRaceId = null) {
    const hashes = hmacClientIpHashes(req, {
      env: dependencies.env || process.env,
      logger: dependencies.logger || console,
    });
    linkOpenDb.linkOpen
      .create({
        data: {
          kind,
          code: code || null,
          sourceRaceId,
          // Both hashes on every open: the exact IP (tier 1) and the network
          // prefix (tier 2). Writing ip_net_hash unconditionally from day one
          // is what lets tier 2 be switched on later without a backfill —
          // rows written before the switch are already matchable.
          ipHash: hashes.ipHash,
          ipNetHash: hashes.ipNetHash,
          ipHashVersion: hashes.version,
          ipNetHashVersion: hashes.version,
        },
      })
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
      logLinkOpen("referral", code, req);
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

    const referralCode = normalizeReferralCode(req.query.ref);
    const links = {
      shareUrl: sharing.buildShareUrl(token, referralCode),
      appDeepLink: sharing.buildAppDeepLink(token, referralCode),
      appStoreUrl: sharing.APP_STORE_URL,
      playStoreUrl: `${sharing.PLAY_STORE_URL}&referrer=${encodeURIComponent(
        `raceToken=${token}${referralCode ? `&ref=${referralCode}` : ""}`
      )}`,
      ogImageUrl: sharing.OG_IMAGE_URL,
    };
    try {
      const preview = await getSharedRacePreview({ token: req.params.token });
      logLinkOpen("race_share", token, req, preview?.id || null);
      if (referralCode) {
        logLinkOpen("referral", referralCode, req, preview?.id || null);
      }
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
    logLinkOpen("tournament_share", token, req);
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
  // The built marketing site (Vite + Vue + shadcn-vue source lives in web/).
  // web/dist IS committed to git — see docs/marketing-site-rebuild-requirements.md:
  // the documented rollback procedure has no build step, so a build-artifact-only
  // dist would leave /privacy (the URL on the App Store listing) serving a stale
  // page or a 500 after any rollback.
  const webDistDir = path.join(__dirname, "..", "web", "dist");

  // ── Android waitlist (marketing site form) ────────────────────────────────
  // Public + unauthenticated: the caller is a browser on barastep.com, not the
  // app. Mounted before the static handlers so /waitlist/* can never be shadowed.
  app.use("/waitlist", createWaitlistRouter(dependencies));

  // ── App Store reviews (marketing site review strip) ───────────────────────
  // Same shape: public, browser-only, mounted ahead of the static handlers.
  // Proxies Apple's public review feed so the site needs no third-party widget
  // script — see src/modules/web/reviews/appStoreReviews.js.
  app.use("/reviews", createReviewsRouter(dependencies));

  // ── CDN-served art ────────────────────────────────────────────────────────
  // The manifest MUST be registered before the static middleware, otherwise
  // express.static (fallthrough:false) answers /assets/manifest with a 404
  // before the route is ever reached.
  app.use("/assets", createAssetsRouter(dependencies));
  // Immutable static art. The asset VERSION is part of the filename, so a given
  // URL's bytes can never change — that's what makes a one-year immutable
  // max-age safe, and it lets Cloudflare (which already proxies this domain)
  // edge-cache every PNG. fallthrough:false turns a missing file into a proper
  // 404 through errorMiddleware instead of falling into the SPA-ish handlers
  // below; index:false forbids directory listings. serve-static's built-in
  // path-traversal protection covers ../ and its encoded forms.
  app.use(
    "/assets",
    express.static(path.join(publicDir, "assets"), {
      immutable: true,
      maxAge: "365d",
      fallthrough: false,
      index: false,
    })
  );

  // ── Marketing site (built from web/) ──────────────────────────────────────
  // Vite's own hashed JS/CSS bundles. Mounted at /web-assets, NOT /assets:
  // the CDN art mount above uses fallthrough:false, so anything Vite emitted
  // under /assets would hard-404 and the site would render unstyled with no JS.
  // web/vite.config.js pins build.assetsDir to match this path — change both or
  // neither.
  // fallthrough:false matches the CDN mount above: a missing bundle is a broken
  // build, and it should 404 loudly through errorMiddleware rather than fall
  // through to the handlers below and answer with something misleading.
  app.use(
    "/web-assets",
    express.static(path.join(webDistDir, "web-assets"), {
      immutable: true,
      maxAge: "365d",
      fallthrough: false,
      index: false,
    })
  );

  app.get("/", (req, res) => res.sendFile(path.join(webDistDir, "index.html")));
  app.get("/support", (req, res) => res.sendFile(path.join(webDistDir, "support.html")));
  app.get("/support.html", (req, res) => res.sendFile(path.join(webDistDir, "support.html")));
  app.get("/privacy", (req, res) => res.sendFile(path.join(webDistDir, "privacy.html")));
  app.get("/privacy.html", (req, res) => res.sendFile(path.join(webDistDir, "privacy.html")));
  // Bundled share-card image for link previews (point OG_IMAGE_URL at this).
  // 404s harmlessly until a public/share-card.png is added.
  app.get("/share-card.png", (req, res) =>
    res.sendFile(path.join(publicDir, "share-card.png"))
  );
  // ── Favicon / touch icons ─────────────────────────────────────────────────
  // The Bara app icon, served from stable unhashed paths in public/ so BOTH the
  // built marketing site and the server-rendered share-link pages can point at
  // the same URLs (the landing pages are template strings and can't reference a
  // Vite-hashed filename). /favicon.ico is requested by browsers automatically
  // even on pages that declare no icon — serving the PNG there is well
  // supported and saves shipping a second format.
  const iconRoutes = [
    ["/favicon.ico", "favicon-32.png"],
    ["/favicon-32.png", "favicon-32.png"],
    ["/apple-touch-icon.png", "apple-touch-icon.png"],
    // iOS asks for these two variants before falling back to the plain name.
    ["/apple-touch-icon-precomposed.png", "apple-touch-icon.png"],
    ["/icon-192.png", "icon-192.png"],
  ];
  for (const [route, file] of iconRoutes) {
    app.get(route, (req, res) =>
      res.sendFile(path.join(publicDir, file), {
        maxAge: "7d",
        headers: { "Content-Type": "image/png" },
      })
    );
  }

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
