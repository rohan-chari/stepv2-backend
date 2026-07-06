const crypto = require("node:crypto");

// AdMob rewarded-ad server-side verification (SSV). Google calls our callback
// URL with a query string whose last two params are always
// &signature=<base64url DER ECDSA-SHA256>&key_id=<id>; the signed message is
// the raw query string up to (not including) "&signature=". Docs:
// https://developers.google.com/admob/android/ssv
const VERIFIER_KEYS_URL =
  "https://www.gstatic.com/admob/reward/verifier-keys.json";

const SIGNATURE_MARKER = "&signature=";

function parseSsvQuery(rawQuery) {
  const params = {};
  for (const [key, value] of new URLSearchParams(rawQuery)) {
    params[key] = value;
  }
  return params;
}

// keys: [{ keyId, pem }] as served by verifier-keys.json. Returns false (never
// throws) on any malformed input — a bad callback must not 500 the route.
function verifySsvSignature({ rawQuery, keys }) {
  if (typeof rawQuery !== "string" || !Array.isArray(keys)) return false;

  const markerIndex = rawQuery.indexOf(SIGNATURE_MARKER);
  if (markerIndex <= 0) return false;
  const message = rawQuery.slice(0, markerIndex);

  const params = parseSsvQuery(rawQuery);
  if (!params.signature || !params.key_id) return false;

  const key = keys.find((k) => String(k.keyId) === String(params.key_id));
  if (!key || !key.pem) return false;

  try {
    return crypto.verify(
      "sha256",
      Buffer.from(message, "utf8"),
      key.pem,
      Buffer.from(params.signature, "base64url")
    );
  } catch {
    return false;
  }
}

// Cached fetcher for Google's rotating public key set. Google rotates keys
// (no more than every 24h per docs), so a short-lived in-process cache is
// safe; on a cache miss after rotation the verify fails, the next call
// refetches, and Google retries the callback.
function buildKeyFetcher({
  url = VERIFIER_KEYS_URL,
  fetchImpl = fetch,
  cacheTtlMs = 60 * 60 * 1000,
} = {}) {
  let cached = null;
  let cachedAt = 0;

  return async function fetchKeys() {
    if (cached && Date.now() - cachedAt < cacheTtlMs) return cached;
    const response = await fetchImpl(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch AdMob SSV keys: ${response.status}`);
    }
    const body = await response.json();
    cached = Array.isArray(body.keys) ? body.keys : [];
    cachedAt = Date.now();
    return cached;
  };
}

module.exports = {
  VERIFIER_KEYS_URL,
  parseSsvQuery,
  verifySsvSignature,
  buildKeyFetcher,
};
