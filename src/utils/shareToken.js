const crypto = require("crypto");

// Opaque, unguessable token used in shareable race links
// (https://<host>/r/<token>). 16 random bytes => 128 bits of entropy, rendered
// as 32 lowercase hex chars. Hex is URL-safe, so the token needs no escaping in
// a path segment, an iMessage link, or an Android/iOS deep-link URI. We mint a
// fresh token per race rather than exposing the race UUID directly, so the link
// can be revoked/rotated without leaking the primary key.
function generateShareToken() {
  return crypto.randomBytes(16).toString("hex");
}

module.exports = { generateShareToken };
