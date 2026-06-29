const crypto = require("node:crypto");

// Reserved namespace for referral codes (REFERRAL_FEATURE_RESEARCH.md §11.7).
// Referral codes live under the SAME /r/* path as race share tokens and satisfy
// the same `^[A-Za-z0-9_-]{1,128}$` charset, so this prefix is the disambiguator
// that lets GET /r/:token (backend) and the client deep-link parser tell a
// referral code apart from a race share token. Race share tokens are hex/base62
// with no hyphen, so they can never collide with this hyphenated prefix.
const REFERRAL_CODE_PREFIX = "BARA-";

// Crockford-style base32 minus ambiguous glyphs (no I/O/0/1) so a code is easy
// to read aloud and type from an SMS. 4 body chars ≈ 28M codes; collisions are
// handled by retry-on-insert against the users.referral_code unique index.
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const CODE_BODY_LENGTH = 4;

// Mint a fresh candidate code (caller retries on unique collision).
function makeReferralCode() {
  const bytes = crypto.randomBytes(CODE_BODY_LENGTH);
  let body = "";
  for (let i = 0; i < CODE_BODY_LENGTH; i++) {
    body += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return REFERRAL_CODE_PREFIX + body;
}

// True if a /r/ token is a referral code (vs a race share token). We always mint
// uppercase, but compare case-insensitively so a lower-cased link still routes.
function looksLikeReferralCode(token) {
  return (
    typeof token === "string" &&
    token.toUpperCase().startsWith(REFERRAL_CODE_PREFIX)
  );
}

// Normalize arbitrary input (manual entry, clipboard URL, deep-link path segment)
// to the canonical stored form, or null if it isn't a plausible referral code.
// Tolerates a full invite URL (…/r/BARA-XXXX) by reducing to its last path
// segment, so a pasted clipboard URL works without the client pre-parsing it.
function normalizeReferralCode(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const lastSegment = trimmed.split("/").filter(Boolean).pop() || trimmed;
  const code = lastSegment.split("?")[0].split("#")[0].trim().toUpperCase();

  if (!looksLikeReferralCode(code)) return null;
  // Prefix + body within the share-token charset (letters/digits only in body).
  if (!/^BARA-[A-Z0-9]{2,32}$/.test(code)) return null;
  return code;
}

module.exports = {
  REFERRAL_CODE_PREFIX,
  CODE_ALPHABET,
  makeReferralCode,
  looksLikeReferralCode,
  normalizeReferralCode,
};
