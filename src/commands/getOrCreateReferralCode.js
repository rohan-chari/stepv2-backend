const { prisma } = require("../db");
const { makeReferralCode } = require("../lib/referralCode");

// Lazily mint (or return the existing) stable referral code for a user.
// Idempotent: a user keeps ONE code for life (so links already shared stay
// valid). Codes are random, so we collision-retry against the
// users.referral_code unique index.
function buildGetOrCreateReferralCode(dependencies = {}) {
  const db = dependencies.prisma || prisma;
  const mint = dependencies.makeReferralCode || makeReferralCode;
  const maxAttempts = dependencies.maxAttempts || 8;

  return async function getOrCreateReferralCode({ userId }) {
    const current = await db.user.findUnique({
      where: { id: userId },
      select: { referralCode: true },
    });
    if (!current) throw new Error("User not found");
    if (current.referralCode) return current.referralCode;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const code = mint();
      try {
        // Guard on referralCode:null so the FIRST concurrent writer wins and a
        // user never flips codes mid-life. count 1 => we set it; count 0 =>
        // a concurrent request set one first, so re-read and return theirs.
        const result = await db.user.updateMany({
          where: { id: userId, referralCode: null },
          data: { referralCode: code },
        });
        if (result.count === 1) return code;

        const fresh = await db.user.findUnique({
          where: { id: userId },
          select: { referralCode: true },
        });
        if (fresh && fresh.referralCode) return fresh.referralCode;
        // count 0 but still null is not expected; loop and retry defensively.
      } catch (error) {
        // P2002 => this random code collides with ANOTHER user's; mint again.
        if (error && error.code === "P2002") continue;
        throw error;
      }
    }
    throw new Error("Could not allocate a unique referral code");
  };
}

const getOrCreateReferralCode = buildGetOrCreateReferralCode();

module.exports = { buildGetOrCreateReferralCode, getOrCreateReferralCode };
