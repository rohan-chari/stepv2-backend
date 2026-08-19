const crypto = require("node:crypto");
const net = require("node:net");

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

// ── Coarse-network prefix (tier 2 of the referral IP fallback) ──────────────
//
// The exact-IP match breaks whenever the referral landing page and the app
// egress from different addresses on the same network: IPv4<->IPv6 selection,
// a Wi-Fi<->cellular flip between tapping the link and finishing signup, or
// plain NAT churn. Hashing the NETWORK PREFIX instead survives all three.
//
// /24 for IPv4 and /64 for IPv6 (the smallest block reliably assigned to one
// site/subscriber). Everything is canonicalized to ONE textual form before
// hashing, because two spellings of the same network must produce the same
// hash — that is the whole point of the tier.

function ipv4Prefix(ip) {
  const octets = ip.split(".");
  if (octets.length !== 4) return null;
  return `${octets[0]}.${octets[1]}.${octets[2]}.0/24`;
}

// Expand an IPv6 literal to its 8 zero-padded lowercase hextets, so
// "2600:1:2:3::x" and "2600:0001:0002:0003:...:y" agree. Returns null on
// anything it cannot parse — callers must treat null as "no prefix", never as
// a match key.
function expandIpv6(ip) {
  let text = ip.toLowerCase();

  // Embedded dotted IPv4 tail (::ffff:1.2.3.4, 64:ff9b::1.2.3.4) — rewrite it
  // as two hextets so the rest of the parser only ever sees hex groups.
  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    if (!net.isIPv4(tail)) return null;
    const [a, b, c, d] = tail.split(".").map(Number);
    text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${(
      (c << 8) |
      d
    ).toString(16)}`;
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;

  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];

  let hextets;
  if (halves.length === 1) {
    if (head.length !== 8) return null;
    hextets = head;
  } else {
    const fill = 8 - head.length - rest.length;
    if (fill < 0) return null;
    hextets = [...head, ...Array(fill).fill("0"), ...rest];
  }

  if (hextets.some((h) => !/^[0-9a-f]{1,4}$/.test(h))) return null;
  return hextets.map((h) => h.padStart(4, "0"));
}

// Canonical network-prefix string for an IP literal, or null when it cannot be
// parsed. Exported for unit coverage: the case matrix (compressed vs expanded
// IPv6, both v4-mapped spellings, the ::/64 sink) is far denser than it is
// practical to drive through HTTP, though the headline cases are covered
// end-to-end in test/integration/referral_attribution_fallback.test.js too.
function networkPrefix(ip) {
  if (!ip) return null;
  let text = String(ip).trim();
  if (!text) return null;

  // [2600:...]:443 bracket form and %eth0 zone ids both appear in the wild.
  if (text.startsWith("[")) {
    const end = text.indexOf("]");
    if (end < 0) return null;
    text = text.slice(1, end);
  }
  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone);

  if (net.isIPv4(text)) return ipv4Prefix(text);
  if (!net.isIPv6(text)) return null;

  const hextets = expandIpv6(text);
  if (!hextets) return null;

  // An IPv4-MAPPED address (::ffff:a.b.c.d) is an IPv4 client that merely
  // arrived through a dual-stack socket: it must hash as that client's v4 /24,
  // NOT as a /64 of the mapped range. Detecting it on the expanded form catches
  // the hex spelling (::ffff:c000:280) as well as the dotted one — both are the
  // same address, and Node/nginx emit either depending on the path.
  const isV4Mapped =
    hextets.slice(0, 5).every((h) => h === "0000") && hextets[5] === "ffff";
  if (isV4Mapped) {
    const hi = parseInt(hextets[6], 16);
    const lo = parseInt(hextets[7], 16);
    return ipv4Prefix(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
  }

  // Anything else whose first four hextets are all zero lives in ::/64 —
  // loopback (::1), the unspecified address, IPv4-compatible legacy forms.
  // Bucketing those together would make one hash stand for a set of unrelated
  // clients, which for an ATTRIBUTION key is a false-positive generator. Refuse
  // rather than emit a prefix nobody should match on.
  if (hextets.slice(0, 4).every((h) => h === "0000")) return null;

  return `${hextets.slice(0, 4).join(":")}::/64`;
}

// Hash of the client's network prefix, resolved from the request exactly as
// hashClientIp does. Null when the IP is absent or unparseable — and a null
// here MUST short-circuit the tier-2 lookup rather than be used as a match
// value (see findLinkOpenReferralCode).
function hashClientNet(req) {
  const prefix = networkPrefix(resolveClientIp(req));
  if (!prefix) return null;
  return crypto.createHash("sha256").update(prefix, "utf8").digest("hex");
}

function canonicalIpBytes(ip) {
  if (!ip) return null;
  let text = String(ip).trim().toLowerCase();
  if (text.startsWith("[")) {
    const end = text.indexOf("]");
    if (end < 0) return null;
    text = text.slice(1, end);
  }
  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone);
  if (net.isIPv4(text)) return Buffer.from(text.split(".").map(Number));
  if (!net.isIPv6(text)) return null;
  const hextets = expandIpv6(text);
  if (!hextets) return null;
  const bytes = Buffer.alloc(16);
  hextets.forEach((hextet, index) => bytes.writeUInt16BE(parseInt(hextet, 16), index * 2));
  return bytes;
}

// Versioned HMAC writer for every new Phase A link_open. Legacy SHA helpers
// remain exported for the bounded 48-hour attribution compatibility read only;
// they are never used by the new writer.
function hmacClientIpHashesForVersion(req, version, { env = process.env } = {}) {
  const secret = Number.isInteger(version) ? env[`REFERRAL_IP_HMAC_SECRET_V${version}`] : null;
  if (!Number.isInteger(version) || version < 1 || typeof secret !== "string" || secret.length < 32) {
    return { ipHash: null, ipNetHash: null, version: null };
  }
  const ip = resolveClientIp(req);
  const exactBytes = canonicalIpBytes(ip);
  const prefix = networkPrefix(ip);
  const hmac = (bytes) =>
    bytes
      ? crypto.createHmac("sha256", secret).update(bytes).digest("hex")
      : null;
  return {
    ipHash: hmac(exactBytes),
    ipNetHash: hmac(prefix ? Buffer.from(prefix, "utf8") : null),
    version,
  };
}

function hmacClientIpHashes(req, { env = process.env, logger = console } = {}) {
  const version = Number(env.REFERRAL_IP_HMAC_ACTIVE_VERSION);
  const hashes = hmacClientIpHashesForVersion(req, version, { env });
  if (hashes.version == null) {
    logger?.error?.("[REFERRAL] active IP HMAC configuration missing or invalid; storing non-deduplicable open");
  }
  return hashes;
}

module.exports = {
  resolveClientIp,
  hashClientIp,
  hashClientNet,
  networkPrefix,
  hmacClientIpHashes,
  hmacClientIpHashesForVersion,
};
