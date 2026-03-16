const jwt = require("jsonwebtoken");

const ISSUER = "steps-tracker-api";
const DEFAULT_EXPIRY = "90d";

class SessionTokenError extends Error {
  constructor(message) {
    super(message);
    this.name = "SessionTokenError";
  }
}

function getSecret() {
  const secret = process.env.SESSION_TOKEN_SECRET;
  if (!secret) {
    throw new Error("SESSION_TOKEN_SECRET environment variable is required");
  }
  return secret;
}

function signSessionToken({ userId, appleId }) {
  return jwt.sign({ appleId }, getSecret(), {
    subject: userId,
    issuer: ISSUER,
    expiresIn: DEFAULT_EXPIRY,
    algorithm: "HS256",
  });
}

function verifySessionToken(token) {
  try {
    return jwt.verify(token, getSecret(), {
      issuer: ISSUER,
      algorithms: ["HS256"],
    });
  } catch (error) {
    throw new SessionTokenError(
      error.name === "TokenExpiredError"
        ? "Session token has expired"
        : "Session token is invalid"
    );
  }
}

module.exports = { signSessionToken, verifySessionToken, SessionTokenError };
