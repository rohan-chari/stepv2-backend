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
