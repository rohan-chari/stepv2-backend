const crypto = require("node:crypto");

// Client-IP resolution + hashing for the referral attribution fallback.
//
// Prod runs behind nginx (DEPLOYMENT.md), so the real client IP arrives in
// X-Forwarded-For; the socket address is the proxy. We take the FIRST entry
// (client as seen by our own nginx — later hops are appended) and fall back to
// the socket address only when the header is absent (local dev / tests).
//
// Only the SHA-256 hash ever leaves this module: the raw IP is never persisted
// (link_opens viewers are anonymous and must stay that way).
function resolveClientIp(req) {
  const xff = req.headers && req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.trim().length > 0) {
    const first = xff.split(",")[0].trim();
    if (first) return first;
  }
  return (req.socket && req.socket.remoteAddress) || req.ip || null;
}

function hashClientIp(req) {
  const ip = resolveClientIp(req);
  if (!ip) return null;
  return crypto.createHash("sha256").update(ip, "utf8").digest("hex");
}

module.exports = { resolveClientIp, hashClientIp };
