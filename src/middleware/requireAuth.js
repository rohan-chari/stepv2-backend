const {
  verifySessionToken,
  SessionTokenError,
} = require("../services/sessionToken");
const {
  AppleIdentityTokenError,
  verifyAppleIdentityToken,
} = require("../services/appleIdentityToken");
const { ensureAppleUser } = require("../services/ensureAppleUser");
const { User } = require("../models/user");

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
