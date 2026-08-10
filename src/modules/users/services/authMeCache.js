// C5 (spec §3 key table `v1:user:{id}:authme`, §5 Phase E2 step 11):
// a 10-second cache of the ASSEMBLED `GET /auth/me` response.
//
// `/auth/me` is the #2 endpoint by volume (26,492 calls / 8 days) and assembles
// from four sources per call: the `users` row, a `friendships` COUNT, a
// `race_participants` SUM (held buy-ins) and the `app_settings` flags.
//
// ═══════════════════════════════════════════════════════════════════════════
// REQUIRED INVALIDATION INVENTORY (spec §5 Phase E2 step 11)
// ═══════════════════════════════════════════════════════════════════════════
// THE RULE: any field the client re-reads IMMEDIATELY after mutating it MUST be
// invalidated at its write site; everything else explicitly accepts ≤10s
// staleness. Classification below is grounded in an audit of every `fetchMe`
// call site in the Flutter client
// (lib/services/backend_api_service.dart:641 and its 7 callers), not in
// guesswork. The 10s TTL remains the backstop for anything misclassified.
//
// This table gates the flag flip: per spec §5 step 11 the C5 flag does not go
// on until it has been reviewed.
//
// ── IMMEDIATE (client reads it back right after writing it) ────────────────
// | Field                        | Source table          | Invalidated at |
// |------------------------------|-----------------------|----------------|
// | coins                        | users.coins           | awardCoins.js + deductCoinsAtomic.js — the ONLY two users.coins writers (pinned by test/services/coinSeamStructuralGuard.test.js) |
// | heldCoins                    | race_participants SUM | Rides the coin seam: every USER-TRIGGERED buyInStatus change is paired with a coin write in the same flow (hold = a debit through buyIns.js -> deductCoinsAtomic; refund/payout = a credit through awardCoins), so the DEL already fired. The ONE exception is settlement's HELD->COMMITTED transition, which moves no coins — it is not a read-back-after-write flow (nobody refreshes /auth/me at settlement) and takes the ≤10s TTL. Note buy-ins are globally off today under funded prize pools. |
// | firstRaceOnboardingSeen      | users                 | User.update (races/routes.js POST /races/onboarding/first-race-seen) + joinRaceCore's tx write |
// | tutorialOnboardingSeen       | users                 | User.update (routes/tutorial.js POST /tutorial/complete-reward, /tutorial/onboarding-seen) |
// | profilePhotoUrl              | users                 | User.update (commands/profilePhoto.js set/remove) |
// | profilePhotoPromptDismissedAt| users                 | User.update (commands/profilePhoto.js dismiss) |
// | incomingFriendRequests       | friendships COUNT     | Friendship.create / updateStatus / delete (both sides invalidated) |
// | equipped cosmetics*          | user_equipped_access. | cosmetics/equipAccessory.js |
//
//   *equips are not fields OF the /auth/me payload today, but the equip flow
//    also rewrites the users row on some paths and the client refreshes profile
//    surfaces right after; invalidating is free and removes the whole question.
//
// ── ACCEPTS ≤10s STALENESS (client uses the MUTATION's response, not a re-read)
// | Field                       | Why it is safe                            |
// |-----------------------------|-------------------------------------------|
// | displayName                 | display_name_screen.dart:190 applies the PUT response locally; no fetchMe follows. (Invalidated anyway via User.update — free.) |
// | renameChipShownCount/DismissedAt | auth_service.dart:766/:548 apply the mutation response |
// | hiddenFromLeaderboard       | auth_service.dart:576 optimistic local write + applyBackendUser(response) |
// | autoJoinFeaturedRaces       | auth_service.dart:607 — same pattern. ALSO written server-side by the seeded-race ghost flip (batch 2026-08-10 item 1): that write goes through User.disableAutoJoinFeaturedRaces, which invalidates per flipped id, so the settings screen can't show the toggle ON against a row the cron already turned off. |
// | isAdmin                     | derived from ADMIN_EMAILS + the user row; changes only by ops |
// | featureFlags.*              | server-side remote flags; the spec explicitly names these as ≤10s-acceptable |
// | characterPowersEnabled      | hard-coded `false`                        |
// | stepGoal                    | deprecated 1.1.4 compat constant          |
// | email, id                   | immutable for the life of the account     |
// | currentTier / rankedTierV2  | written weekly by ranked settlement; display-only counter |
// | lastStepSyncAt              | bookkeeping; not read by the client       |
// | timezone, clientFeatures    | never read from /auth/me by the client (clientFeatures is an OUTBOUND header only) |
// | referredByCode              | The onboarding invite-code step hides itself on this field, but never by reading it back after a write: on a successful redeem the client acts on the REDEEM RESPONSE (`attributed: true`) plus its local done-flag, and an attributed-at-provision user gets the value in the provision response itself (ensure*User merges it — the freshness fix). So the only stale window is a redeem performed on ANOTHER device within 10s, whose worst case is one redundant prompt answered by `already_attributed` and dismissed. Deliberately NOT invalidated from the social module: recordReferral/redeemReferralCode are raw-`tx` writers (see the chokepoint note below), and reaching across modules to DEL a users cache key would buy nothing but coupling. |
//
// ── ACCOUNT-STATE CHANGES ─────────────────────────────────────────────────
// deleteUserAccount invalidates (the row is gone; a warm payload would describe
// a deleted account). Provider link / ensureAppleUser / ensureGoogleUser write
// through `User.update`, so they are covered by the chokepoint below.
//
// ── HOW THE HOOKS ARE PLACED (and the one honest residual) ────────────────
// Rather than sprinkle DELs, the chokepoint is `User.update` and its siblings in
// `modules/users/models/user.js` — every users-row mutation in the codebase goes
// through one of them EXCEPT the raw `tx.user.update` calls inside larger
// transactions (recordStepSyncV2, claimDailyReward*, joinRaceCore,
// autoEnrollNewUser, recordReferral, redeemReferralCode, ranked settlement) and
// the two coin seams. Every one of those that touches an IMMEDIATE field is
// hooked explicitly; the rest ride the 10s TTL by the rule above.
//
// RESIDUAL, accepted and bounded: `deductCoinsAtomic` may be called with a
// caller-supplied `tx`, so its DEL fires just BEFORE that transaction commits.
// A concurrent `/auth/me` landing in that millisecond window could re-warm the
// pre-commit balance for up to 10s. The four `tx`-passing purchase commands
// therefore invalidate AGAIN after their transaction commits, which closes the
// window for every path a user can trigger; the TTL covers the theoretical rest.
// ═══════════════════════════════════════════════════════════════════════════
const derivedCache = require("../../../shared/cache/derivedCache");
const cacheKeys = require("../../../shared/cache/cacheKeys");

// 10s per the key table and the owner decision (spec §10 Q3).
const TTL_SECONDS = 10;

/**
 * Read-through the assembled `/auth/me` payload.
 *
 * @param {object} opts
 * @param {string} opts.userId
 * @param {boolean} opts.fineBucketVariant see cacheKeys.userAuthMe — the ONLY
 *   request-varying input to the payload.
 * @param {boolean} opts.enabled the C5 app-setting flag
 * @param {() => Promise<object>} opts.load the existing Postgres assembly
 */
async function read({ userId, fineBucketVariant, enabled, load }) {
  if (!enabled || !userId) return load();
  return derivedCache.cachedRead({
    key: cacheKeys.userAuthMe(userId, fineBucketVariant),
    prefix: cacheKeys.PREFIX.USER_AUTHME,
    ttlSeconds: TTL_SECONDS,
    enabled: true,
    load,
  });
}

/**
 * Invalidate-only seam (spec §3): deletes BOTH app-version variants. Never
 * writes the new payload — the next reader rebuilds it.
 */
async function invalidate(userId) {
  if (!userId) return true;
  return derivedCache.invalidate({
    keys: cacheKeys.userAuthMeVariants(userId),
    prefix: cacheKeys.PREFIX.USER_AUTHME,
  });
}

/**
 * Never let cache bookkeeping fail the mutation it is hanging off. Every call
 * site here is a real write (coins, onboarding, profile) that has already
 * committed; a Redis hiccup must degrade to "≤10s stale", never to a 500.
 */
async function invalidateSafe(userId) {
  try {
    return await invalidate(userId);
  } catch {
    return false;
  }
}

/** Both sides of a friendship — the pending-request COUNT changes for each. */
async function invalidatePairSafe(a, b) {
  await Promise.all([invalidateSafe(a), invalidateSafe(b)]);
}

module.exports = {
  read,
  invalidate,
  invalidateSafe,
  invalidatePairSafe,
  TTL_SECONDS,
};
