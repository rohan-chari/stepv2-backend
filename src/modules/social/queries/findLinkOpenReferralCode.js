const { prisma } = require("../../../db");

// IP-correlated deferred referral attribution (the backend-only fix for the
// iOS install gap — 2026-08-07). The referral landing page records a hashed
// client IP on its link_opens row; when a brand-new user provisions WITHOUT a
// referralCode in the body, the provisioners ask this query: "which code did
// this IP open recently?"
//
// Returns the normalized code, or null. Attribution fires ONLY when the answer
// is unambiguous and plausibly one household/phone:
//   * at least one referral open from this ipHash within the window,
//   * exactly ONE distinct code among them (two codes = ambiguous = no-op),
//   * a sane open count (a hot IP — carrier NAT, a shared proxy, or nginx
//     misconfigured so every request hashes alike — must never attribute).
//
// False-positive cost is bounded anyway: the result only ever creates a
// PENDING attribution (payout still requires a real qualifying race), the
// refereeSubHash unique caps it at once per human forever, and the referrer
// velocity caps still apply downstream.
const FALLBACK_WINDOW_HOURS = Number(
  process.env.REFERRAL_IP_FALLBACK_WINDOW_HOURS || 48
);
const MAX_OPENS_PER_IP = Number(
  process.env.REFERRAL_IP_FALLBACK_MAX_OPENS || 10
);

function buildFindLinkOpenReferralCode(dependencies = {}) {
  const db = dependencies.prisma || prisma;

  return async function findLinkOpenReferralCode({ ipHash }) {
    if (!ipHash) return null;

    const since = new Date(Date.now() - FALLBACK_WINDOW_HOURS * 60 * 60 * 1000);
    const opens = await db.linkOpen.findMany({
      where: { kind: "referral", ipHash, createdAt: { gte: since } },
      select: { code: true },
      take: MAX_OPENS_PER_IP + 1,
    });

    if (opens.length === 0 || opens.length > MAX_OPENS_PER_IP) return null;

    const codes = new Set(opens.map((o) => o.code).filter(Boolean));
    if (codes.size !== 1) return null;

    return codes.values().next().value;
  };
}

const findLinkOpenReferralCode = buildFindLinkOpenReferralCode();

module.exports = { buildFindLinkOpenReferralCode, findLinkOpenReferralCode };
