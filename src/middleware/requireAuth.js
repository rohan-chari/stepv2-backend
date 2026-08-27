const {
  verifySessionToken,
  SessionTokenError,
} = require("../modules/users/services/sessionToken");
const {
  AppleIdentityTokenError,
  verifyAppleIdentityToken,
} = require("../modules/users/services/appleIdentityToken");
const { ensureAppleUser } = require("../modules/users/services/ensureAppleUser");
const { User } = require("../modules/users/models/user");
const { prisma: defaultPrisma } = require("../db");
const { appSettings: defaultAppSettings } = require("../shared/config/appSettings");
const {
  globalEventTimezoneMutation,
} = require("../modules/users/services/globalEventTimezone");
const {
  recordOperationalCounters,
} = require("../modules/steps/services/globalStepEventObservability");
const {
  buildGlobalEventTimezoneReconciliation,
} = require("../modules/steps/services/globalEventTimezoneReconciliation");
const {
  invalidateHomeActiveGlobalEvent,
} = require("../modules/steps/services/globalStepEventEntitlement");
const authMeCache = require("../modules/users/services/authMeCache");

// Batch 2026-08-08 item 9. Byte-identical to the regex the analytics ingestion
// endpoint uses to bound `appVersion` (src/modules/analytics/routes.js:84).
// It is a `const` local to that router and not exported, and this change does
// not own that file, so it is duplicated here rather than re-exported. If one
// side is ever loosened the other must follow — both bound the SAME untrusted
// X-App-Version header from the SAME client field (PackageInfo.version), and
// the whole point is that admin reporting groups on values from both.
const SAFE_APP_VERSION =
  /^(?:unknown|\d{1,4}(?:\.\d{1,4}){1,3}(?:[+-][A-Za-z0-9.-]{1,16})?)$/;

// UTC calendar date ("2026-08-08") of a Date. The sticky write is rate-limited
// to once per UTC day; UTC (not the user's zone) is deliberate — it is a write
// throttle, not a reported metric, so it only has to be a stable, cheap,
// server-side bucket. The admin report reads a 30-day window, which no choice
// of day boundary can skew.
function utcDateKey(date) {
  return date.toISOString().slice(0, 10);
}

class AuthError extends Error {
  constructor(message) {
    super(message);
    this.name = "AuthError";
  }
}

function extractBearerToken(authorizationHeader) {
  if (!authorizationHeader) {
    throw new AuthError("Authorization bearer token is required");
  }

  const [scheme, token] = authorizationHeader.split(" ");

  if (scheme !== "Bearer" || !token) {
    throw new AuthError("Authorization header must use Bearer token");
  }

  return token;
}

function buildRequireAuth(dependencies = {}) {
  const verifyIdentityToken =
    dependencies.verifyAppleIdentityToken || verifyAppleIdentityToken;
  const ensureUser = dependencies.ensureAppleUser || ensureAppleUser;
  const verifySession = dependencies.verifySessionToken || verifySessionToken;
  const userModel = dependencies.User || User;
  const prisma = dependencies.prisma || defaultPrisma;
  const settings = dependencies.appSettings || defaultAppSettings;
  const timezoneReconciliation =
    dependencies.reconcileGlobalEventTimezone ||
    (dependencies.User
      ? null
      : buildGlobalEventTimezoneReconciliation({ ...dependencies, prisma }));

  async function recordAdminMetricsEligibility(req, user) {
    try {
      // The Flutter client advertises admin_metrics_v2 only on iOS. Do not use
      // Apple identity as a proxy: Google Sign-In is also supported on iOS.
      if (
        user?.isReviewAccount === true ||
        req.clientFeatures?.has("admin_metrics_v2") !== true ||
        typeof userModel.stampMetricsV2Eligibility !== "function" ||
        (await settings.getFlag("adminMetricsV2TelemetryEnabled")) !== true
      ) return;
      const epoch = await prisma.adminMetricsCollectionEpoch.findFirst({
        where: { endedAt: null },
        orderBy: { startedAt: "desc" },
        select: { id: true },
      });
      if (!epoch || user.metricsV2EligibleEpochId === epoch.id) return;
      await userModel.stampMetricsV2Eligibility(user.id, epoch.id);
    } catch {
      // Analytics eligibility is best-effort and never blocks auth.
    }
  }

  // TR-706: persist the user's client capability tokens (stamped on
  // req.clientFeatures by extractClientFeatures, which runs before every
  // router).
  //
  // STICKY / UNION (product ruling 2026-07-15): once a token has been seen for
  // a user it is NEVER dropped — we only ever add. A single authed request that
  // happens to omit the header (an internal caller, a retry, a surface that
  // forgot it) must not flicker that user to "needs app update" across every
  // friend's picker (TR-708) or block their invites (TR-707) — a common,
  // user-visible failure. The opposite risk (a genuine app DOWNGRADE never
  // registering, so a stale-eligible user gets invited) is rare and is already
  // backstopped at accept time by TR-703's 400 UPDATE_REQUIRED.
  //
  // Writes only when the header carries a token we haven't recorded yet, so the
  // steady state (and every header-less request) is zero extra writes.
  // Best-effort: any failure is swallowed — feature bookkeeping must never
  // break an authenticated request.
  async function recordClientFeatures(req, user) {
    try {
      if (!user || !(req.clientFeatures instanceof Set)) return;
      if (typeof userModel.updateClientFeatures !== "function") return;
      const stored = Array.isArray(user.clientFeatures)
        ? user.clientFeatures
        : [];
      const storedSet = new Set(stored);
      const hasNewToken = [...req.clientFeatures].some(
        (token) => !storedSet.has(token)
      );
      if (!hasNewToken) return; // union already covered — nothing to write
      const union = [...new Set([...stored, ...req.clientFeatures])].sort();
      await userModel.updateClientFeatures(user.id, union);
    } catch {
      // Never let feature bookkeeping fail the request.
    }
  }

  // §7: sticky-write the user's IANA timezone from the request-scoped X-Timezone
  // header, mirroring recordClientFeatures. extractTimezone squashes an absent or
  // invalid header to the "America/New_York" default, so we ONLY write when the
  // raw header was itself a valid zone (raw === req.timeZone) AND it differs from
  // what's stored. That keeps a header-less internal/retry request from clobbering
  // a real zone with the default (the same flicker guard TR-706 uses), and makes
  // the steady state — and every header-less request — zero extra writes. Never
  // on every request (commit 3e6c827's pool-exhaustion revert). Best-effort: any
  // failure is swallowed so bookkeeping can't break an authenticated request.
  async function recordTimezone(req, user) {
    try {
      if (!user || typeof userModel.updateTimezone !== "function") return;
      const rawTz = req.headers && req.headers["x-timezone"];
      // A valid header is exactly the case where extractTimezone accepted it, so
      // req.timeZone === rawTz. Absent/invalid => req.timeZone is the default and
      // rawTz !== req.timeZone => skip.
      if (!rawTz || rawTz !== req.timeZone) return;
      if (user.timezone === req.timeZone) return; // unchanged — nothing to write
      await userModel.updateTimezone(user.id, req.timeZone);
    } catch {
      // Never let timezone bookkeeping fail the request.
    }
  }

  async function recordGlobalEventTimezone(req, user) {
    try {
      if (!user || typeof userModel.updateGlobalEventTimezoneState !== "function") return;
      const rawTz = req.headers && req.headers["x-timezone"];
      if (!rawTz || rawTz !== req.timeZone) return;
      const mutation = globalEventTimezoneMutation({
        user,
        observedTimezone: rawTz,
        now: new Date(),
      });
      if (!mutation) return;
      await userModel.updateGlobalEventTimezoneState(user.id, mutation);
      await recordOperationalCounters(prisma, {
        ...(mutation.globalEventTimezone ? { timezoneCandidatesPromoted: 1 } : {}),
        ...(mutation.globalEventTimezoneCandidate ? { timezoneCandidatesChanged: 1 } : {}),
      });
    } catch {
      // Stable scheduling metadata is best-effort and cannot fail auth.
    }
  }

  async function reconcileTimezone(req, user) {
    const rawTz = req.headers && req.headers["x-timezone"];
    if (!rawTz || rawTz !== req.timeZone) return;
    if (!timezoneReconciliation) {
      await recordTimezone(req, user);
      await recordGlobalEventTimezone(req, user);
      return;
    }
    try {
      const result = await timezoneReconciliation({
        user,
        observedTimezone: rawTz,
      });
      if (result?.user) {
        req.user = { ...req.user, ...result.user };
        await Promise.allSettled([
          authMeCache.invalidateSafe(user.id),
          result.relocated?.length
            ? invalidateHomeActiveGlobalEvent([user.id])
            : Promise.resolve(),
        ]);
      }
    } catch {
      // The requested endpoint always fails open; unchanged users.timezone is
      // the durable marker that makes the next authenticated request retry.
    }
  }

  // Batch 2026-08-08 item 9: sticky-write `users.lastAppVersion` +
  // `users.lastSeenAt` from the X-App-Version header, so admins can see the
  // version spread of the live install base. Third sibling of
  // recordClientFeatures / recordTimezone and it obeys the same two rules.
  //
  // RULE 1 — NEVER PER REQUEST (commit 3e6c827: a per-request users-row write
  // exhausted the connection pool). ONE combined UPDATE fires only when:
  //   * the validated header differs from the stored lastAppVersion, OR
  //   * the stored lastSeenAt is on an earlier UTC day (or is null).
  // Steady state for an unchanged app on its second request of the day is ZERO
  // writes, so the ceiling is one write per user per day plus one per upgrade.
  //
  // RULE 2 — DO NOT GO THROUGH THE `User.update` CHOKEPOINT. Every method on
  // the User model DELs the cached `/auth/me` payload (see
  // users/services/authMeCache.js). `/auth/me` is the #2 endpoint by volume and
  // its cache has a 10s TTL, so a daily DEL per user would evict a warm payload
  // for essentially every active user every day for a field the client never
  // reads. `User.touchLastSeen` therefore deliberately bypasses invalidation —
  // it is safe precisely because neither column is ever serialized to a client.
  //
  // A missing or malformed header is NOT an error: the version is simply not
  // stored (the user still counts as seen, and lands in the admin "unknown"
  // bucket). Best-effort throughout — any failure is swallowed and logged, and
  // can never fail an authenticated request.
  async function recordAppVersion(req, user) {
    try {
      if (!user || typeof userModel.touchLastSeen !== "function") return;

      const raw = req.headers && req.headers["x-app-version"];
      const version =
        typeof raw === "string" && SAFE_APP_VERSION.test(raw) ? raw : null;

      const now = new Date();
      const seenAt = user.lastSeenAt ? new Date(user.lastSeenAt) : null;
      const versionChanged = version !== null && version !== user.lastAppVersion;
      const newUtcDay =
        !seenAt ||
        Number.isNaN(seenAt.getTime()) ||
        utcDateKey(seenAt) !== utcDateKey(now);

      if (!versionChanged && !newUtcDay) return; // steady state: no write

      // Only overwrite lastAppVersion when this request actually carried a
      // valid one. A header-less internal call or retry must not wipe a real
      // recorded version (the same flicker guard TR-706/§7 use).
      await userModel.touchLastSeen(user.id, {
        lastSeenAt: now,
        ...(version !== null ? { lastAppVersion: version } : {}),
      });
    } catch (error) {
      // Never let version bookkeeping fail the request.
      console.warn("recordAppVersion failed (ignored):", error?.message);
    }
  }

  return async function requireAuth(req, res, next) {
    try {
      const token = extractBearerToken(req.headers.authorization);

      // Strategy 1: Try as session token
      try {
        const payload = verifySession(token);
        const user = await userModel.findById(payload.sub);

        if (!user) {
          return res.status(401).json({ error: "User not found" });
        }

        req.user = user;
        await recordClientFeatures(req, user);
        await reconcileTimezone(req, user);
        await recordAppVersion(req, user);
        await recordAdminMetricsEligibility(req, user);
        return next();
      } catch (error) {
        if (error instanceof SessionTokenError) {
          // If it looks like a session token but is expired/invalid, reject
          // We detect this by checking if the token has 3 dot-separated segments
          // and the first segment decodes to a JSON with alg: HS256
          try {
            const headerSegment = token.split(".")[0];
            const header = JSON.parse(
              Buffer.from(headerSegment, "base64url").toString("utf8")
            );
            if (header.alg === "HS256") {
              return res.status(401).json({ error: error.message });
            }
          } catch {
            // Not a session token format — fall through to Apple verification
          }
        }
        // Not a session token — fall through to Apple identity token
      }

      // Strategy 2: Fall back to Apple identity token verification
      const appleIdentity = await verifyIdentityToken(token);
      const user = await ensureUser({
        appleId: appleIdentity.sub,
        email: appleIdentity.email,
      });

      req.appleIdentity = appleIdentity;
      req.user = user;
      await recordClientFeatures(req, user);
      await reconcileTimezone(req, user);
      await recordAppVersion(req, user);
      await recordAdminMetricsEligibility(req, user);

      next();
    } catch (error) {
      if (
        error instanceof AuthError ||
        error instanceof AppleIdentityTokenError
      ) {
        return res.status(401).json({ error: error.message });
      }

      console.error("Auth middleware error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  };
}

module.exports = { buildRequireAuth };
