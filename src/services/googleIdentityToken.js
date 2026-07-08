const crypto = require("node:crypto");

// Google ID-token verifier — the Google counterpart of appleIdentityToken.js.
// The Android app signs in with google_sign_in configured with our WEB OAuth
// client id as serverClientId, so its ID token's `aud` is that web client id
// (NOT the Android client id). On iOS, the Google SDK instead issues ID tokens
// with `aud` = the iOS OAuth client id. GOOGLE_AUTH_CLIENT_ID therefore accepts
// a comma-separated allowlist (web client id + iOS client ids); a single value
// keeps working unchanged.
const GOOGLE_ISSUERS = ["accounts.google.com", "https://accounts.google.com"];
const GOOGLE_KEYS_URL = "https://www.googleapis.com/oauth2/v3/certs";
// Fallback TTL if the certs response has no usable Cache-Control max-age.
const DEFAULT_KEYS_CACHE_TTL_MS = 1000 * 60 * 60;

let cachedGoogleKeys;
let cachedGoogleKeysExpiry = 0;

class GoogleIdentityTokenError extends Error {
  constructor(message) {
    super(message);
    this.name = "GoogleIdentityTokenError";
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
    throw new GoogleIdentityTokenError(`Google identity token ${label} is invalid`);
  }
}

function parseMaxAgeMs(cacheControlHeader) {
  if (!cacheControlHeader) return null;
  const match = /max-age=(\d+)/i.exec(cacheControlHeader);
  if (!match) return null;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

async function fetchGoogleSigningKeys() {
  const now = Date.now();

  if (cachedGoogleKeys && now < cachedGoogleKeysExpiry) {
    return cachedGoogleKeys;
  }

  const response = await fetch(GOOGLE_KEYS_URL);

  if (!response.ok) {
    throw new GoogleIdentityTokenError("Unable to fetch Google signing keys");
  }

  const payload = await response.json();

  if (!payload.keys || !Array.isArray(payload.keys)) {
    throw new GoogleIdentityTokenError("Google signing keys response is invalid");
  }

  // Google rotates these keys; honor the response's max-age so we don't serve
  // stale keys past their lifetime (which would reject otherwise-valid tokens).
  const ttl =
    parseMaxAgeMs(response.headers.get("cache-control")) ||
    DEFAULT_KEYS_CACHE_TTL_MS;

  cachedGoogleKeys = payload.keys;
  cachedGoogleKeysExpiry = now + ttl;

  return cachedGoogleKeys;
}

function getConfiguredAudiences() {
  const raw = process.env.GOOGLE_AUTH_CLIENT_ID;
  const audiences = (raw || "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (audiences.length === 0) {
    throw new GoogleIdentityTokenError(
      "GOOGLE_AUTH_CLIENT_ID environment variable is required"
    );
  }
  return audiences;
}

function validatePayloadClaims(payload) {
  const expectedAudiences = getConfiguredAudiences();
  const nowInSeconds = Math.floor(Date.now() / 1000);
  const audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud];

  if (!GOOGLE_ISSUERS.includes(payload.iss)) {
    throw new GoogleIdentityTokenError("Google identity token issuer is invalid");
  }

  if (!audience.some((aud) => expectedAudiences.includes(aud))) {
    throw new GoogleIdentityTokenError("Google identity token audience is invalid");
  }

  if (typeof payload.exp !== "number" || payload.exp <= nowInSeconds) {
    throw new GoogleIdentityTokenError("Google identity token has expired");
  }

  if (payload.nbf && payload.nbf > nowInSeconds) {
    throw new GoogleIdentityTokenError("Google identity token is not valid yet");
  }

  if (!payload.sub) {
    throw new GoogleIdentityTokenError("Google identity token subject is missing");
  }
}

async function verifyGoogleIdentityToken(identityToken) {
  if (!identityToken) {
    throw new GoogleIdentityTokenError("Google identity token is required");
  }

  const segments = identityToken.split(".");

  if (segments.length !== 3) {
    throw new GoogleIdentityTokenError("Google identity token format is invalid");
  }

  const [encodedHeader, encodedPayload, encodedSignature] = segments;
  const header = parseJsonSegment(encodedHeader, "header");
  const payload = parseJsonSegment(encodedPayload, "payload");

  if (header.alg !== "RS256" || !header.kid) {
    throw new GoogleIdentityTokenError("Google identity token header is invalid");
  }

  const keys = await fetchGoogleSigningKeys();
  const signingKey = keys.find((key) => key.kid === header.kid && key.alg === "RS256");

  if (!signingKey) {
    throw new GoogleIdentityTokenError("Google signing key was not found");
  }

  const publicKey = crypto.createPublicKey({
    key: signingKey,
    format: "jwk",
  });
  const signature = decodeBase64Url(encodedSignature);
  const signedData = Buffer.from(`${encodedHeader}.${encodedPayload}`);
  const isValid = crypto.verify("RSA-SHA256", signedData, publicKey, signature);

  if (!isValid) {
    throw new GoogleIdentityTokenError("Google identity token signature is invalid");
  }

  validatePayloadClaims(payload);

  return payload;
}

module.exports = {
  GoogleIdentityTokenError,
  verifyGoogleIdentityToken,
};
