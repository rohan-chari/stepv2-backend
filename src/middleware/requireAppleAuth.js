const {
  AppleIdentityTokenError,
  verifyAppleIdentityToken,
} = require("../services/appleIdentityToken");
const { ensureAppleUser } = require("../services/ensureAppleUser");

function extractBearerToken(authorizationHeader) {
  if (!authorizationHeader) {
    throw new AppleIdentityTokenError("Authorization bearer token is required");
  }

  const [scheme, token] = authorizationHeader.split(" ");

  if (scheme !== "Bearer" || !token) {
    throw new AppleIdentityTokenError("Authorization header must use Bearer token");
  }

  return token;
}

function buildRequireAppleAuth(dependencies = {}) {
  const verifyIdentityToken =
    dependencies.verifyAppleIdentityToken || verifyAppleIdentityToken;
  const ensureUser = dependencies.ensureAppleUser || ensureAppleUser;

  return async function requireAppleAuth(req, res, next) {
    try {
      const identityToken = extractBearerToken(req.headers.authorization);
      const appleIdentity = await verifyIdentityToken(identityToken);
      const user = await ensureUser({
        appleId: appleIdentity.sub,
        email: appleIdentity.email,
      });

      req.appleIdentity = appleIdentity;
      req.user = user;

      next();
    } catch (error) {
      if (error instanceof AppleIdentityTokenError) {
        return res.status(401).json({ error: error.message });
      }

      console.error("Auth middleware error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  };
}

module.exports = { buildRequireAppleAuth };
