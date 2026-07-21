const crypto = require("node:crypto");

// SHA-256-hex hash of the Apple `sub` (stored as user.appleId). We persist and
// compare only this hash in the OnboardingBoxGrant ledger so the raw Apple sub
// never lands in that table. The hash is stable across reinstall/re-sign-in
// (the Apple sub itself is stable), which is what makes the one-time onboarding
// grant abuse-proof against delete-account-and-recreate.
function hashAppleSub(appleSub) {
  if (typeof appleSub !== "string" || appleSub.length === 0) {
    return null;
  }
  return crypto.createHash("sha256").update(appleSub, "utf8").digest("hex");
}

module.exports = { hashAppleSub };
