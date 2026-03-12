const crypto = require("node:crypto");

const APPLE_ISSUER = "https://appleid.apple.com";
const DEFAULT_APPLE_AUDIENCE = "com.rohanchari.steptracker";
const APPLE_KEYS_URL = "https://appleid.apple.com/auth/keys";
const APPLE_KEYS_CACHE_TTL_MS = 1000 * 60 * 60;

let cachedAppleKeys;
let cachedAppleKeysAt = 0;

class AppleIdentityTokenError extends Error {
  constructor(message) {
    super(message);
    this.name = "AppleIdentityTokenError";
  }
}

function decodeBase64Url(base64UrlValue) {
  const normalized = base64UrlValue.replace(/-/g, "+").replace(/_/g, "/");
  const paddingLength = (4 - (normalized.length % 4)) % 4;
  const padded = normalized.padEnd(normalized.length + paddingLength, "=");

  return Buffer.from(padded, "base64");
}

function parseJsonSegment(segment, label) {
  try {
    return JSON.parse(decodeBase64Url(segment).toString("utf8"));
  } catch (error) {
    throw new AppleIdentityTokenError(`Apple identity token ${label} is invalid`);
  }
}

async function fetchAppleSigningKeys() {
  const now = Date.now();

  if (cachedAppleKeys && now - cachedAppleKeysAt < APPLE_KEYS_CACHE_TTL_MS) {
    return cachedAppleKeys;
  }

  const response = await fetch(APPLE_KEYS_URL);

  if (!response.ok) {
    throw new AppleIdentityTokenError("Unable to fetch Apple signing keys");
  }

  const payload = await response.json();

  if (!payload.keys || !Array.isArray(payload.keys)) {
    throw new AppleIdentityTokenError("Apple signing keys response is invalid");
  }

  cachedAppleKeys = payload.keys;
  cachedAppleKeysAt = now;

  return cachedAppleKeys;
}

function getConfiguredAudience() {
  return process.env.APPLE_AUDIENCE || DEFAULT_APPLE_AUDIENCE;
}

function validatePayloadClaims(payload) {
  const expectedAudience = getConfiguredAudience();
  const nowInSeconds = Math.floor(Date.now() / 1000);
  const audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud];

  if (payload.iss !== APPLE_ISSUER) {
    throw new AppleIdentityTokenError("Apple identity token issuer is invalid");
  }

  if (!audience.includes(expectedAudience)) {
    throw new AppleIdentityTokenError("Apple identity token audience is invalid");
  }

  if (typeof payload.exp !== "number" || payload.exp <= nowInSeconds) {
    throw new AppleIdentityTokenError("Apple identity token has expired");
  }

  if (payload.nbf && payload.nbf > nowInSeconds) {
    throw new AppleIdentityTokenError("Apple identity token is not valid yet");
  }

  if (!payload.sub) {
    throw new AppleIdentityTokenError("Apple identity token subject is missing");
  }
}

async function verifyAppleIdentityToken(identityToken) {
  if (!identityToken) {
    throw new AppleIdentityTokenError("Apple identity token is required");
  }

  const segments = identityToken.split(".");

  if (segments.length !== 3) {
    throw new AppleIdentityTokenError("Apple identity token format is invalid");
  }

  const [encodedHeader, encodedPayload, encodedSignature] = segments;
  const header = parseJsonSegment(encodedHeader, "header");
  const payload = parseJsonSegment(encodedPayload, "payload");

  if (header.alg !== "RS256" || !header.kid) {
    throw new AppleIdentityTokenError("Apple identity token header is invalid");
  }

  const keys = await fetchAppleSigningKeys();
  const signingKey = keys.find((key) => key.kid === header.kid && key.alg === "RS256");

  if (!signingKey) {
    throw new AppleIdentityTokenError("Apple signing key was not found");
  }

  const publicKey = crypto.createPublicKey({
    key: signingKey,
    format: "jwk",
  });
  const signature = decodeBase64Url(encodedSignature);
  const signedData = Buffer.from(`${encodedHeader}.${encodedPayload}`);
  const isValid = crypto.verify("RSA-SHA256", signedData, publicKey, signature);

  if (!isValid) {
    throw new AppleIdentityTokenError("Apple identity token signature is invalid");
  }

  validatePayloadClaims(payload);

  return payload;
}

module.exports = {
  AppleIdentityTokenError,
  verifyAppleIdentityToken,
};
