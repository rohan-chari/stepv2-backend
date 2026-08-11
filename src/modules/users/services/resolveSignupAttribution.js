// Which referral code (if any) a BRAND-NEW signup should be attributed to, and
// by WHICH MECHANISM — shared by ensureAppleUser and ensureGoogleUser so the
// two provisioners cannot drift. Called from the create branch only.
//
// Precedence, highest first:
//   1. `referralCode` in the provision body  -> source "provision_body"
//      (the clipboard / deep-link handoff worked)
//   2. the IP-correlated link_opens fallback -> source "ip_fallback_exact"
//      (tier 1, exact IP) or "ip_fallback_net" (tier 2, network prefix)
//   3. nothing                               -> organic signup
//
// Best-effort by construction: a throwing or malformed fallback resolves to an
// organic signup. SIGNUP MUST NEVER FAIL because of referral attribution.

const TIER_SOURCES = {
  exact: "ip_fallback_exact",
  net: "ip_fallback_net",
};

async function resolveSignupAttribution({
  referralCode,
  referralSourceRaceId = null,
  fallbackReferralCode,
  signupId,
}) {
  if (referralCode) {
    return {
      code: referralCode,
      source: "provision_body",
      sourceRaceId: referralSourceRaceId || null,
    };
  }
  if (!fallbackReferralCode) return { code: null, source: null, sourceRaceId: null };

  try {
    // The thunk is passed the new user's id purely so the query can name it in
    // its [REFERRAL] decline lines. Doubles that take no arguments are
    // unaffected.
    const resolved = await fallbackReferralCode(signupId);
    if (!resolved) return { code: null, source: null };

    // TOLERATE BOTH SHAPES. findLinkOpenReferralCode returns
    // `{code, tier}` since the two-tier change, but injected test doubles (and
    // any caller not yet updated) may still hand back a bare code string.
    // Feeding an object into normalizeReferralCode would yield null and
    // silently downgrade a real referral to an organic signup, so this is a
    // correctness guard, not politeness.
    if (typeof resolved === "string") {
      return { code: resolved, source: TIER_SOURCES.exact, sourceRaceId: null };
    }
    if (typeof resolved === "object" && resolved.code) {
      const source = TIER_SOURCES[resolved.tier] || TIER_SOURCES.exact;
      return {
        code: resolved.code,
        source,
        sourceRaceId: resolved.sourceRaceId || null,
      };
    }
  } catch (_) {
    // Fallback lookup failure = organic signup; never blocks provisioning.
  }

  return { code: null, source: null, sourceRaceId: null };
}

// Logged only once the write actually landed, so the line means "this user IS
// attributed", not "we tried". Bare-console convention, plain string
// interpolation — this sits in the signup path and must never throw.
function logAttributionResolved({ source, code, userId }) {
  const tier =
    source === "ip_fallback_net"
      ? "net"
      : source === "ip_fallback_exact"
      ? "exact"
      : null;
  if (!tier) return; // body codes are not a fallback resolution
  console.log(
    `[REFERRAL] ip-fallback (${tier}) resolved ${code} for user ${userId}`
  );
}

module.exports = { resolveSignupAttribution, logAttributionResolved };
