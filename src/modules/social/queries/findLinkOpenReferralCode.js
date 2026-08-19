const { prisma } = require("../../../db");

// IP-correlated deferred referral attribution (the backend-only fix for the
// iOS install gap — 2026-08-07). The referral landing page records a hashed
// client IP on its link_opens row; when a brand-new user provisions WITHOUT a
// referralCode in the body, the provisioners ask this query: "which code did
// this IP open recently?"
//
// TWO TIERS (invite-code onboarding spec, part D). Returns
// `{ code, tier: "exact" | "net" }` or null:
//
//   tier 1 "exact" — the hashed client IP, unchanged from the original design.
//   tier 2 "net"   — the hashed NETWORK PREFIX (IPv4 /24, IPv6 /64), which
//                    survives the IPv4<->IPv6 and Wi-Fi<->cellular flips that
//                    silently break an exact match.
//
// Attribution fires ONLY when the answer is unambiguous and plausibly one
// household/phone, per tier:
//   * at least one referral open within the window,
//   * exactly ONE distinct code among them (two codes = ambiguous = no-op),
//   * a sane open count (a hot IP — carrier NAT, a shared proxy, or nginx
//     misconfigured so every request hashes alike — must never attribute).
//
// TIER 2 IS TRIED ONLY WHEN TIER 1 FOUND **ZERO** OPENS. A tier-1 decline for
// ambiguity or heat is strictly STRONGER evidence that this is a shared
// network, so widening the net after one would add exactly the false positives
// the guards exist to prevent.
//
// False-positive cost is bounded anyway: the result only ever creates a
// PENDING attribution (payout still requires a real qualifying race), the
// refereeSubHash unique caps it at once per human forever, the referrer
// velocity caps still apply downstream, and — because tier 2 stamps its own
// `source` — an explicit manual redeem can pre-empt a tier-2 guess outright
// (see redeemReferralCode).
//
// RETURN-SHAPE NOTE: this used to return a bare code string. Callers must
// handle the object form; ensureAppleUser/ensureGoogleUser tolerate both so an
// injected test double returning a plain string still works.
const FALLBACK_WINDOW_HOURS = Number(
  process.env.REFERRAL_IP_FALLBACK_WINDOW_HOURS || 48
);
const MAX_OPENS_PER_IP = Number(
  process.env.REFERRAL_IP_FALLBACK_MAX_OPENS || 10
);

// Tier-2 knobs are read PER CALL, not at module load, so the switch can be
// flipped by a plain pm2 restart-with-env and so tests can exercise both
// postures against one long-lived server.
//
// DEFAULT OFF. The matching code, column, stamping and tests all ship now, but
// tier 2 goes live only once `npm run referrals:audit` shows the per-day tier-1
// volumes and lets us judge the false-positive surface. The honest cost: an
// IPv4 /24 on carrier NAT is shared by thousands of strangers, and the
// exactly-one-distinct-code rule does NOT protect against a farmer whose code
// is the only one opened from that /24 in 48h.
function netTierEnabled() {
  const raw = String(
    process.env.REFERRAL_IP_FALLBACK_NET_ENABLED ?? "0"
  ).trim().toLowerCase();
  return raw === "1" || raw === "true";
}

function netTierMaxOpens() {
  const value = Number(process.env.REFERRAL_IP_FALLBACK_NET_MAX_OPENS);
  return Number.isFinite(value) && value > 0 ? value : 10;
}

// Observability (spec step 3). Bare-console convention, plain string
// interpolation only — this runs inside the signup path and must never throw.
// A zero-open lookup stays SILENT: that is the ordinary organic signup and
// logging it would bury the signal in noise.
function logDecline(tier, reason, signupId) {
  console.log(
    `[REFERRAL] ip-fallback (${tier}) declined (${reason}) for signup ${
      signupId || "unknown"
    }`
  );
}

function buildFindLinkOpenReferralCode(dependencies = {}) {
  const db = dependencies.prisma || prisma;

  // One tier's lookup. Reports the open COUNT alongside the verdict because
  // the tier-2 gate keys on "tier 1 saw zero opens", not on "tier 1 returned
  // no code".
  async function lookupTier({ tier, field, value, versionField, version, maxOpens, since, signupId }) {
    const opens = await db.linkOpen.findMany({
      where: {
        kind: "referral",
        [field]: value,
        ...(versionField ? { [versionField]: version } : {}),
        createdAt: { gte: since },
      },
      select: { code: true, sourceRaceId: true },
      orderBy: { createdAt: "desc" },
      take: maxOpens + 1,
    });

    if (opens.length === 0) return { count: 0, code: null };

    if (opens.length > maxOpens) {
      logDecline(tier, "hot-ip", signupId);
      return { count: opens.length, code: null };
    }

    const codes = new Set(opens.map((o) => o.code).filter(Boolean));
    if (codes.size !== 1) {
      logDecline(tier, "ambiguous", signupId);
      return { count: opens.length, code: null };
    }

    const code = codes.values().next().value;
    return {
      count: opens.length,
      code,
      sourceRaceId:
        opens.find((open) => open.code === code && open.sourceRaceId)?.sourceRaceId ||
        null,
    };
  }

  return async function findLinkOpenReferralCode({
    ipHash,
    ipNetHash,
    ipHashVersion,
    ipNetHashVersion,
    previousIpHash,
    previousIpNetHash,
    previousIpHashVersion,
    previousIpNetHashVersion,
    legacyIpHash,
    legacyIpNetHash,
    signupId,
  } = {}) {
    const since = new Date(Date.now() - FALLBACK_WINDOW_HOURS * 60 * 60 * 1000);

    // ── Tier 1: exact IP ────────────────────────────────────────────────
    if (ipHash) {
      const exact = await lookupTier({
        tier: "exact",
        field: "ipHash",
        value: ipHash,
        versionField: ipHashVersion == null ? null : "ipHashVersion",
        version: ipHashVersion,
        maxOpens: MAX_OPENS_PER_IP,
        since,
        signupId,
      });
      if (exact.code) {
        return {
          code: exact.code,
          tier: "exact",
          sourceRaceId: exact.sourceRaceId || null,
        };
      }
      // Found opens but declined them → never widen to the coarser tier.
      if (exact.count > 0) return null;
    }

    // This timestamp is updated whenever the active writer version changes.
    // It bounds both first-enable legacy reads and rotation previous-version
    // reads to the same 48-hour compatibility interval.
    const enabledAt = new Date(process.env.REFERRAL_IP_HMAC_ENABLED_AT || "invalid");
    const compatibilityReadOpen =
      !Number.isNaN(enabledAt.getTime()) &&
      Date.now() >= enabledAt.getTime() &&
      Date.now() - enabledAt.getTime() <= 48 * 60 * 60 * 1000;
    if (compatibilityReadOpen && previousIpHash && previousIpHashVersion != null) {
      const previous = await lookupTier({
        tier: "exact-previous",
        field: "ipHash",
        value: previousIpHash,
        versionField: "ipHashVersion",
        version: previousIpHashVersion,
        maxOpens: MAX_OPENS_PER_IP,
        since,
        signupId,
      });
      if (previous.code) {
        return { code: previous.code, tier: "exact", sourceRaceId: previous.sourceRaceId || null };
      }
      if (previous.count > 0) return null;
    }
    if (ipHashVersion === 1 && compatibilityReadOpen && legacyIpHash) {
      const legacy = await lookupTier({
        tier: "exact-legacy",
        field: "ipHash",
        value: legacyIpHash,
        versionField: "ipHashVersion",
        version: null,
        maxOpens: MAX_OPENS_PER_IP,
        since,
        signupId,
      });
      if (legacy.code) {
        return {
          code: legacy.code,
          tier: "exact",
          sourceRaceId: legacy.sourceRaceId || null,
        };
      }
      if (legacy.count > 0) return null;
    }

    // ── Tier 2: network prefix ──────────────────────────────────────────
    if (!netTierEnabled()) return null;
    // A NULL net hash must skip the tier ENTIRELY. `where: { ipNetHash: null }`
    // would match every pre-deploy legacy row at once and attribute off
    // whatever single code happened to be among them — mirrors the ipHash
    // guard above, and is the reason this is an explicit early return rather
    // than a falsy value flowing into the query.
    if (!ipNetHash) return null;

    const netMatch = await lookupTier({
      tier: "net",
      field: "ipNetHash",
      value: ipNetHash,
      versionField: ipNetHashVersion == null ? null : "ipNetHashVersion",
      version: ipNetHashVersion,
      maxOpens: netTierMaxOpens(),
      since,
      signupId,
    });
    if (netMatch.code) {
      return {
        code: netMatch.code,
        tier: "net",
        sourceRaceId: netMatch.sourceRaceId || null,
      };
    }
    if (netMatch.count > 0) return null;

    if (compatibilityReadOpen && previousIpNetHash && previousIpNetHashVersion != null) {
      const previousNet = await lookupTier({
        tier: "net-previous",
        field: "ipNetHash",
        value: previousIpNetHash,
        versionField: "ipNetHashVersion",
        version: previousIpNetHashVersion,
        maxOpens: netTierMaxOpens(),
        since,
        signupId,
      });
      if (previousNet.code) {
        return { code: previousNet.code, tier: "net", sourceRaceId: previousNet.sourceRaceId || null };
      }
      if (previousNet.count > 0) return null;
    }

    if (ipNetHashVersion === 1 && compatibilityReadOpen && legacyIpNetHash) {
      const legacyNet = await lookupTier({
        tier: "net-legacy",
        field: "ipNetHash",
        value: legacyIpNetHash,
        versionField: "ipNetHashVersion",
        version: null,
        maxOpens: netTierMaxOpens(),
        since,
        signupId,
      });
      if (legacyNet.code) {
        return { code: legacyNet.code, tier: "net", sourceRaceId: legacyNet.sourceRaceId || null };
      }
    }

    return null;
  };
}

const findLinkOpenReferralCode = buildFindLinkOpenReferralCode();

module.exports = { buildFindLinkOpenReferralCode, findLinkOpenReferralCode };
