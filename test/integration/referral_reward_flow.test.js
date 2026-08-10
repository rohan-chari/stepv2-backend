// Integration tests for the friend-referral reward path, walked as a brand-new
// user's journey: get a code → install via an invite (signup attribution) →
// finish a first *qualifying* race → reward fires (double-sided) → and the
// anti-abuse / idempotency guards around all of it.
//
// These run against the real test Postgres (steps-tracker-integration, see
// `npm run test:integration`) with the real Prisma client, because the entire
// "reward exactly once, never double-pay" guarantee is enforced by DB
// constraints — @@unique([refereeSubHash, role]) on the grant and
// @@unique([userId, reason, refId]) on the coin ledger — which a fake-db unit
// test could not exercise.
//
// Reward amounts assert against the referralRewards config (so a product tune of
// the numbers doesn't break the suite), but the reason/refId strings are
// asserted LITERALLY — those are the idempotency contract and should fail loudly
// if ever changed.

const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");

const { prisma, cleanDatabase, getSharedServer } = require("./setup");

const { hashAppleSub } = require("../../src/modules/users/appleSubHash");
const { looksLikeReferralCode } = require("../../src/shared/lib/referralCode");
const {
  REFERRER_REWARD_COINS,
  REFEREE_REWARD_COINS,
  QUALIFY_WINDOW_DAYS,
  REFERRAL_DAILY_CAP,
} = require("../../src/modules/social/referralRewards");

const { getOrCreateReferralCode } = require("../../src/modules/social/commands/getOrCreateReferralCode");
const { recordReferral } = require("../../src/modules/social/commands/recordReferral");
const { redeemReferralCode } = require("../../src/modules/social/commands/redeemReferralCode");
const {
  grantReferralRewardsForRace,
} = require("../../src/modules/social/commands/grantReferralReward");
const { buildCompleteRace } = require("../../src/modules/races/commands/completeRace");
const { getReferralPreview } = require("../../src/modules/social/queries/getReferralPreview");
const { getReferralStatus } = require("../../src/modules/social/queries/getReferralStatus");

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Monotonic counter so unique columns (appleId, email, displayName) never
// collide WITHIN a run. cleanDatabase() truncates users between tests, so we
// only need uniqueness within the process, not a reset.
let seq = 0;

async function makeUser(overrides = {}) {
  seq += 1;
  return prisma.user.create({
    data: {
      appleId: overrides.appleId || `apple-ref-${seq}`,
      email: overrides.email || `ref-${seq}@example.com`,
      displayName:
        overrides.displayName === undefined ? `User ${seq}` : overrides.displayName,
      ...overrides,
    },
  });
}

// Create a race + its participants in one shot. Defaults to ACTIVE so
// completeRace's updateIfActive (status:"ACTIVE") guard lets it through.
// participants: [{ user, status="ACCEPTED", placement, totalSteps }]
async function seedRace({ seedId = null, status = "ACTIVE", participants }) {
  return prisma.race.create({
    data: {
      name: `Race ${(seq += 1)}`,
      targetSteps: 10000,
      status,
      seedId,
      participants: {
        create: participants.map((p) => ({
          userId: p.user.id,
          status: p.status || "ACCEPTED",
          placement: p.placement ?? null,
          totalSteps: p.totalSteps ?? 0,
        })),
      },
    },
  });
}

// A fake event bus that records emitted (event, payload) pairs, so we can assert
// exactly which REFERRAL_REWARDED events fired without touching the global bus.
function makeFakeBus() {
  const emitted = [];
  return {
    emitted,
    emit(event, data) {
      emitted.push({ event, data });
    },
  };
}

function referralRewardTxns(userId) {
  return prisma.coinTransaction.findMany({
    where: { userId, reason: "referral_reward" },
  });
}

async function getReferral(refereeId) {
  return prisma.referral.findUnique({ where: { refereeId } });
}

async function coinsOf(userId) {
  const u = await prisma.user.findUnique({ where: { id: userId } });
  return u.coins;
}

// ---------------------------------------------------------------------------

before(async () => {
  // Boot the shared server once so the Prisma client / app are initialized the
  // same way the rest of the integration suite expects.
  await getSharedServer();
});

beforeEach(async () => {
  await cleanDatabase();
  // race_seeds is NOT in cleanDatabase's TRUNCATE list (it has no FK to users).
  // Scope the cleanup to ONLY the seed this file creates ("test-referral-seed")
  // so reruns keep its `kind`/`id` unique — never `deleteMany({})`, which would
  // also wipe the DAILY_10K/WEEKLY_50K rows that `migrate deploy` provisions once
  // at suite start and that sibling suites (race-finish-reward, seeded-race-
  // prereg) depend on in the shared test DB.
  await prisma.raceSeed.deleteMany({ where: { id: "test-referral-seed" } });
});

// ===========================================================================
// Step 0 — a referrer exists and owns a stable code
// ===========================================================================
describe("Step 0 — referrer code (getOrCreateReferralCode)", () => {
  it("mints a BARA- code for a user", async () => {
    const u = await makeUser();
    const code = await getOrCreateReferralCode({ userId: u.id });
    assert.ok(looksLikeReferralCode(code), `expected a BARA- code, got ${code}`);
    const fresh = await prisma.user.findUnique({ where: { id: u.id } });
    assert.equal(fresh.referralCode, code);
  });

  it("is idempotent — the same user keeps ONE code for life", async () => {
    const u = await makeUser();
    const first = await getOrCreateReferralCode({ userId: u.id });
    const second = await getOrCreateReferralCode({ userId: u.id });
    assert.equal(first, second);
  });
});

// ===========================================================================
// Step 1 — a new user installs via the invite and signs up (attribution).
// recordReferral is the exact function the auth provisioner calls in its
// new-user create branch.
// ===========================================================================
describe("Step 1 — signup attribution (recordReferral)", () => {
  async function makeReferrerWithCode() {
    const referrer = await makeUser();
    const code = await getOrCreateReferralCode({ userId: referrer.id });
    return { referrer, code };
  }

  it("records a PENDING referral + audit mirror and mints NO coins (Apple 3.2.2)", async () => {
    const { referrer, code } = await makeReferrerWithCode();
    const referee = await makeUser();

    await recordReferral({ newUser: referee, referralCode: code });

    const ref = await getReferral(referee.id);
    assert.ok(ref, "expected a Referral row");
    assert.equal(ref.status, "PENDING");
    assert.equal(ref.referrerId, referrer.id);
    assert.equal(ref.refereeId, referee.id);
    assert.equal(ref.code, code);
    assert.equal(ref.refereeSubHash, hashAppleSub(referee.appleId));

    const refreshed = await prisma.user.findUnique({ where: { id: referee.id } });
    assert.equal(refreshed.referredByCode, code, "audit mirror set on user");

    // The whole point: nothing pays at signup.
    assert.equal(await prisma.coinTransaction.count(), 0);
    assert.equal(await prisma.referralRewardGrant.count(), 0);
    assert.equal(await coinsOf(referrer.id), 0);
    assert.equal(await coinsOf(referee.id), 0);
  });

  it("ignores a self-referral (own code) — no referral row", async () => {
    const referrer = await makeUser();
    const code = await getOrCreateReferralCode({ userId: referrer.id });
    await recordReferral({ newUser: referrer, referralCode: code });
    assert.equal(await prisma.referral.count(), 0);
  });

  it("ignores an unknown code — organic signup, no referral row", async () => {
    const referee = await makeUser();
    await recordReferral({ newUser: referee, referralCode: "BARA-ZZZZ" });
    assert.equal(await prisma.referral.count(), 0);
  });

  it("excludes a review-account REFERRER — no referral row", async () => {
    const referrer = await makeUser({ isReviewAccount: true });
    const code = await getOrCreateReferralCode({ userId: referrer.id });
    const referee = await makeUser();
    await recordReferral({ newUser: referee, referralCode: code });
    assert.equal(await prisma.referral.count(), 0);
  });

  it("excludes a review-account REFEREE — no referral row", async () => {
    const { code } = await makeReferrerWithCode();
    const referee = await makeUser({ isReviewAccount: true });
    await recordReferral({ newUser: referee, referralCode: code });
    assert.equal(await prisma.referral.count(), 0);
  });

  it("re-attribution for the same human (reinstall) stays a single referral", async () => {
    const { code } = await makeReferrerWithCode();
    const referee = await makeUser({ appleId: `apple-reinstall-${seq}` });

    await recordReferral({ newUser: referee, referralCode: code });
    // Same human signs in again (same appleId → same refereeSubHash). P2002 on
    // refereeSubHash is swallowed; signup must never fail on a referral code.
    await recordReferral({ newUser: referee, referralCode: code });

    assert.equal(await prisma.referral.count(), 1);
  });
});

// ===========================================================================
// Step 2 — referee finishes their FIRST qualifying race → the reward fires.
// ===========================================================================
describe("Step 2 — reward on first qualifying race (happy path)", () => {
  async function attributedReferee() {
    const referrer = await makeUser();
    const code = await getOrCreateReferralCode({ userId: referrer.id });
    const referee = await makeUser();
    await recordReferral({ newUser: referee, referralCode: code });
    return { referrer, referee };
  }

  it("pays referrer + referee on a multi-person qualifying race and flips REWARDED", async () => {
    const { referrer, referee } = await attributedReferee();
    const opponent = await makeUser(); // 2nd ACCEPTED finisher → race qualifies

    const bus = makeFakeBus();
    const completeRace = buildCompleteRace({ eventBus: bus });

    const race = await seedRace({
      participants: [
        { user: referee, placement: 2, totalSteps: 5000 },
        { user: opponent, placement: 1, totalSteps: 8000 },
      ],
    });
    await completeRace({
      raceId: race.id,
      winnerUserId: opponent.id,
      participantUserIds: [referee.id, opponent.id],
    });

    const ref = await getReferral(referee.id);
    assert.equal(ref.status, "REWARDED");

    // Two grants, one per role.
    const grants = await prisma.referralRewardGrant.findMany({
      where: { referralId: ref.id },
    });
    const byRole = Object.fromEntries(grants.map((g) => [g.role, g]));
    assert.deepEqual(Object.keys(byRole).sort(), ["REFEREE", "REFERRER"]);
    assert.equal(byRole.REFERRER.userId, referrer.id);
    assert.equal(byRole.REFEREE.userId, referee.id);

    // Exact coin-ledger rows: amount from config, reason/refId asserted literally.
    const referrerTxns = await referralRewardTxns(referrer.id);
    assert.equal(referrerTxns.length, 1);
    assert.equal(referrerTxns[0].amount, REFERRER_REWARD_COINS);
    assert.equal(referrerTxns[0].reason, "referral_reward");
    assert.equal(referrerTxns[0].refId, `referral:${ref.id}:REFERRER`);

    const refereeTxns = await referralRewardTxns(referee.id);
    assert.equal(refereeTxns.length, 1);
    assert.equal(refereeTxns[0].amount, REFEREE_REWARD_COINS);
    assert.equal(refereeTxns[0].refId, `referral:${ref.id}:REFEREE`);

    // Balances incremented (non-seeded race mints no finish reward → clean).
    assert.equal(await coinsOf(referrer.id), REFERRER_REWARD_COINS);
    assert.equal(await coinsOf(referee.id), REFEREE_REWARD_COINS);

    // Exactly one REFERRAL_REWARDED event (referee side does not emit a payload).
    const events = bus.emitted.filter((e) => e.event === "REFERRAL_REWARDED");
    assert.equal(events.length, 1);
    assert.deepEqual(events[0].data, {
      referrerId: referrer.id,
      refereeId: referee.id,
      coins: REFERRER_REWARD_COINS,
    });
  });

  // A seed whose id is NOT in raceFinishReward config: it exercises the seedId
  // path but mints 0 finish reward, keeping the balance assertions clean.
  async function testSeed() {
    return prisma.raceSeed.create({
      data: {
        id: "test-referral-seed",
        kind: "TEST_REFERRAL",
        name: "Test Referral Seed",
        targetSteps: 10000,
        cadence: "DAILY",
      },
    });
  }

  // ── Batch 2026-08-09 item 2 — DELIBERATE BEHAVIOR INVERSION ───────────────
  //
  // This assertion used to read "a SEEDED solo race also qualifies (seedId
  // path) and pays". It is inverted here on purpose, with owner sign-off in
  // docs/feature-batch-2026-08-09-requirements.md item 2 — a product-behavior
  // change, NOT a weakened assertion. The gate went from
  //   race.seedId != null || realParticipants.length >= 2
  // to
  //   race.seedId == null && realParticipants.length >= 2
  // because every new account is auto-enrolled in the seeded dailies, so the
  // old rule completed a referral within ~24h for zero real engagement.
  //
  // The assertion is STRENGTHENED rather than merely flipped: it pins that the
  // referral survives as PENDING (still able to qualify inside its 30-day
  // window via a real race), that neither side was paid, and that no grant row
  // exists.
  it("a SEEDED solo race does NOT qualify (auto-enrolled daily is not engagement)", async () => {
    const { referrer, referee } = await attributedReferee();
    const seed = await testSeed();

    const completeRace = buildCompleteRace({ eventBus: makeFakeBus() });
    const race = await seedRace({
      seedId: seed.id,
      participants: [{ user: referee, placement: 1, totalSteps: 6000 }],
    });
    await completeRace({ raceId: race.id, winnerUserId: referee.id, participantUserIds: [referee.id] });

    const ref = await getReferral(referee.id);
    assert.equal(ref.status, "PENDING", "referral stays claimable, not rewarded");
    assert.equal(await prisma.referralRewardGrant.count(), 0);
    assert.equal(await coinsOf(referrer.id), 0);
    assert.equal(await coinsOf(referee.id), 0);
  });

  // The architect-required hardening case. The solo-seeded test above would
  // ALSO pass under a buggy `seedId == null || length >= 2`; only a seeded race
  // with two genuine finishers separates the correct AND from that OR.
  it("a SEEDED race with TWO real finishers still does NOT qualify", async () => {
    const { referrer, referee } = await attributedReferee();
    const opponent = await makeUser();
    const seed = await testSeed();

    const completeRace = buildCompleteRace({ eventBus: makeFakeBus() });
    const race = await seedRace({
      seedId: seed.id,
      participants: [
        { user: referee, placement: 2, totalSteps: 5000 },
        { user: opponent, placement: 1, totalSteps: 8000 },
      ],
    });
    await completeRace({
      raceId: race.id,
      winnerUserId: opponent.id,
      participantUserIds: [referee.id, opponent.id],
    });

    const ref = await getReferral(referee.id);
    assert.equal(ref.status, "PENDING");
    assert.equal(await prisma.referralRewardGrant.count(), 0);
    assert.equal(await coinsOf(referrer.id), 0);
    assert.equal(await coinsOf(referee.id), 0);
  });

  // Polarity-flip guard. The gate moved from fail-CLOSED (`undefined != null`
  // is false) to fail-OPEN (`undefined == null` is true), so a caller handing
  // over a race projection that never SELECTed seedId would silently re-qualify
  // every seeded daily. completeRace loads via Race.findById, which uses
  // `include` (all scalars) — this pins that the object it hands over really
  // does carry the key, so a future lean `select:` on that path fails here
  // rather than in prod.
  it("the settlement path hands grantReferralRewardsForRace a race carrying seedId", async () => {
    const { referee } = await attributedReferee();
    const opponent = await makeUser();
    const seed = await testSeed();
    const race = await seedRace({
      seedId: seed.id,
      participants: [
        { user: referee, placement: 2, totalSteps: 5000 },
        { user: opponent, placement: 1, totalSteps: 8000 },
      ],
    });

    let handedOver = null;
    const completeRace = buildCompleteRace({
      eventBus: makeFakeBus(),
      grantReferralRewardsForRace: async ({ race: r }) => {
        handedOver = r;
        return [];
      },
    });
    await completeRace({
      raceId: race.id,
      winnerUserId: opponent.id,
      participantUserIds: [referee.id, opponent.id],
    });

    assert.ok(handedOver, "settlement called the referral service");
    assert.ok(
      Object.prototype.hasOwnProperty.call(handedOver, "seedId"),
      "the race projection MUST carry seedId or the gate fails open"
    );
    assert.equal(handedOver.seedId, seed.id);
  });

  // The gate's own fail-closed backstop, exercised directly at the service
  // seam rather than through settlement (no settlement path can produce this
  // object today — that is exactly why it needs pinning).
  it("a race object with NO seedId key is treated as unqualified, not qualified", async () => {
    const { referrer, referee } = await attributedReferee();
    const opponent = await makeUser();

    const events = await grantReferralRewardsForRace({
      race: {
        id: "projection-without-seed-id",
        participants: [
          { userId: referee.id, status: "ACCEPTED", placement: 2, totalSteps: 5000 },
          { userId: opponent.id, status: "ACCEPTED", placement: 1, totalSteps: 8000 },
        ],
      },
    });

    assert.deepEqual(events, []);
    assert.equal((await getReferral(referee.id)).status, "PENDING");
    assert.equal(await coinsOf(referrer.id), 0);
  });
});

// ===========================================================================
// Step 3 — idempotency: a race that settles twice must not double-pay.
// ===========================================================================
describe("Step 3 — idempotency (no double-pay)", () => {
  async function rewardedRaceSetup() {
    const referrer = await makeUser();
    const code = await getOrCreateReferralCode({ userId: referrer.id });
    const referee = await makeUser();
    await recordReferral({ newUser: referee, referralCode: code });
    const opponent = await makeUser();
    const race = await seedRace({
      participants: [
        { user: referee, placement: 2, totalSteps: 5000 },
        { user: opponent, placement: 1, totalSteps: 8000 },
      ],
    });
    return { referrer, referee, opponent, race };
  }

  it("completeRace called twice on the same race pays exactly once", async () => {
    const { referrer, referee, opponent, race } = await rewardedRaceSetup();
    const completeRace = buildCompleteRace({ eventBus: makeFakeBus() });

    const first = await completeRace({ raceId: race.id, winnerUserId: opponent.id });
    const second = await completeRace({ raceId: race.id, winnerUserId: opponent.id });

    assert.ok(first, "first settlement returns the race");
    assert.equal(second, null, "second settlement no-ops (race no longer ACTIVE)");

    assert.equal((await referralRewardTxns(referrer.id)).length, 1);
    assert.equal((await referralRewardTxns(referee.id)).length, 1);
    assert.equal(await prisma.referralRewardGrant.count(), 2);
    assert.equal(await coinsOf(referrer.id), REFERRER_REWARD_COINS);
    assert.equal(await coinsOf(referee.id), REFEREE_REWARD_COINS);
  });

  it("grantReferralRewardsForRace called twice directly is idempotent", async () => {
    const { referrer, referee, race } = await rewardedRaceSetup();
    const full = await prisma.race.findUnique({
      where: { id: race.id },
      include: { participants: true },
    });

    await grantReferralRewardsForRace({ race: full });
    await grantReferralRewardsForRace({ race: full });

    assert.equal((await referralRewardTxns(referrer.id)).length, 1);
    assert.equal((await referralRewardTxns(referee.id)).length, 1);
    assert.equal(await coinsOf(referrer.id), REFERRER_REWARD_COINS);
    assert.equal(await coinsOf(referee.id), REFEREE_REWARD_COINS);
  });
});

// ===========================================================================
// Step 4 — the "first QUALIFYING race" gate (not just "first race").
// ===========================================================================
describe("Step 4 — qualifying-race gate", () => {
  async function attributedReferee() {
    const referrer = await makeUser();
    const code = await getOrCreateReferralCode({ userId: referrer.id });
    const referee = await makeUser();
    await recordReferral({ newUser: referee, referralCode: code });
    return { referrer, referee };
  }

  it("a solo non-seeded race does NOT pay (stays PENDING), but a later qualifying race does", async () => {
    const { referrer, referee } = await attributedReferee();
    const completeRace = buildCompleteRace({ eventBus: makeFakeBus() });

    // Race 1: solo, non-seeded → not qualifying.
    const solo = await seedRace({
      participants: [{ user: referee, placement: 1, totalSteps: 4000 }],
    });
    await completeRace({ raceId: solo.id, winnerUserId: referee.id });

    let ref = await getReferral(referee.id);
    assert.equal(ref.status, "PENDING", "non-qualifying race must not reward");
    assert.equal(await coinsOf(referrer.id), 0);
    assert.equal(await coinsOf(referee.id), 0);

    // Race 2: genuine 2-person contest → qualifies → pays from the still-PENDING
    // attribution. Proves "first *qualifying*", not "first race".
    const opponent = await makeUser();
    const real = await seedRace({
      participants: [
        { user: referee, placement: 2, totalSteps: 5000 },
        { user: opponent, placement: 1, totalSteps: 9000 },
      ],
    });
    await completeRace({ raceId: real.id, winnerUserId: opponent.id });

    ref = await getReferral(referee.id);
    assert.equal(ref.status, "REWARDED");
    assert.equal(await coinsOf(referrer.id), REFERRER_REWARD_COINS);
    assert.equal(await coinsOf(referee.id), REFEREE_REWARD_COINS);
  });

  it("a second participant who didn't actually walk (steps 0) doesn't satisfy the >=2 gate", async () => {
    const { referrer, referee } = await attributedReferee();
    const noShow = await makeUser();
    const completeRace = buildCompleteRace({ eventBus: makeFakeBus() });

    const race = await seedRace({
      participants: [
        { user: referee, placement: 1, totalSteps: 5000 },
        { user: noShow, status: "ACCEPTED", placement: null, totalSteps: 0 },
      ],
    });
    await completeRace({ raceId: race.id, winnerUserId: referee.id });

    const ref = await getReferral(referee.id);
    assert.equal(ref.status, "PENDING");
    assert.equal(await coinsOf(referrer.id), 0);
    assert.equal(await coinsOf(referee.id), 0);
  });
});

// ===========================================================================
// Reward-time guards (window expiry, review exclusion, deleted referrer,
// velocity cap).
// ===========================================================================
describe("Reward-time guards", () => {
  async function attributedReferee() {
    const referrer = await makeUser();
    const code = await getOrCreateReferralCode({ userId: referrer.id });
    const referee = await makeUser();
    await recordReferral({ newUser: referee, referralCode: code });
    return { referrer, referee };
  }

  async function qualifyingRace(referee) {
    const opponent = await makeUser();
    return seedRace({
      participants: [
        { user: referee, placement: 2, totalSteps: 5000 },
        { user: opponent, placement: 1, totalSteps: 8000 },
      ],
    });
  }

  it("a PENDING attribution older than the window → EXPIRED, no coins", async () => {
    const { referrer, referee } = await attributedReferee();
    const ref = await getReferral(referee.id);
    // Age it past the qualify window.
    await prisma.referral.update({
      where: { id: ref.id },
      data: { createdAt: new Date(Date.now() - (QUALIFY_WINDOW_DAYS + 1) * DAY_MS) },
    });

    const completeRace = buildCompleteRace({ eventBus: makeFakeBus() });
    const race = await qualifyingRace(referee);
    await completeRace({ raceId: race.id, winnerUserId: referee.id });

    const after = await getReferral(referee.id);
    assert.equal(after.status, "EXPIRED");
    assert.equal(await coinsOf(referrer.id), 0);
    assert.equal(await coinsOf(referee.id), 0);
    assert.equal(await prisma.referralRewardGrant.count(), 0);
  });

  it("a review-account referee at reward time → EXCLUDED, no coins", async () => {
    const { referrer, referee } = await attributedReferee();
    // Flip to review AFTER attribution (recordReferral would have skipped a
    // review referee outright).
    await prisma.user.update({ where: { id: referee.id }, data: { isReviewAccount: true } });

    const completeRace = buildCompleteRace({ eventBus: makeFakeBus() });
    const race = await qualifyingRace(referee);
    await completeRace({ raceId: race.id, winnerUserId: referee.id });

    const after = await getReferral(referee.id);
    assert.equal(after.status, "EXCLUDED");
    assert.equal(await coinsOf(referrer.id), 0);
    assert.equal(await prisma.referralRewardGrant.count(), 0);
  });

  it("a deleted/SetNull referrer still pays the referee (no referrer grant, no event)", async () => {
    const { referrer, referee } = await attributedReferee();
    const ref = await getReferral(referee.id);
    // Simulate the referrer account having been deleted (FK SetNull).
    await prisma.referral.update({ where: { id: ref.id }, data: { referrerId: null } });

    const bus = makeFakeBus();
    const completeRace = buildCompleteRace({ eventBus: bus });
    const race = await qualifyingRace(referee);
    await completeRace({ raceId: race.id, winnerUserId: referee.id });

    const after = await getReferral(referee.id);
    assert.equal(after.status, "REWARDED");
    // Referee still gets their welcome.
    assert.equal(await coinsOf(referee.id), REFEREE_REWARD_COINS);
    // Referrer (now null) is unpaid and not credited.
    assert.equal(await coinsOf(referrer.id), 0);
    const grants = await prisma.referralRewardGrant.findMany({ where: { referralId: ref.id } });
    assert.equal(grants.length, 1);
    assert.equal(grants[0].role, "REFEREE");
    // No REFERRAL_REWARDED event — only the referrer grant emits one.
    assert.equal(bus.emitted.filter((e) => e.event === "REFERRAL_REWARDED").length, 0);
  });

  it("a referrer over the daily velocity cap → referral held FLAGGED, neither side paid", async () => {
    const { referrer, referee } = await attributedReferee();

    // Pre-load the referrer to the daily cap with committed REFERRER grants
    // (distinct refereeSubHash each, granted within the last day).
    for (let i = 0; i < REFERRAL_DAILY_CAP; i++) {
      await prisma.referralRewardGrant.create({
        data: {
          userId: referrer.id,
          role: "REFERRER",
          refereeSubHash: `cap-filler-${seq}-${i}`,
          coins: REFERRER_REWARD_COINS,
        },
      });
    }

    const completeRace = buildCompleteRace({ eventBus: makeFakeBus() });
    const race = await qualifyingRace(referee);
    await completeRace({ raceId: race.id, winnerUserId: referee.id });

    const after = await getReferral(referee.id);
    assert.equal(after.status, "FLAGGED");
    // Whole referral held — referee is not paid either.
    assert.equal(await coinsOf(referee.id), 0);
    assert.equal((await referralRewardTxns(referrer.id)).length, 0);
    // Only the filler grants exist; no new grant for THIS referral.
    const grantsForRef = await prisma.referralRewardGrant.findMany({ where: { referralId: after.id } });
    assert.equal(grantsForRef.length, 0);
  });
});

// ===========================================================================
// Late attribution — redeemReferralCode (the iOS clipboard / manual-entry path
// that resolves AFTER account creation).
// ===========================================================================
describe("Late attribution (redeemReferralCode)", () => {
  async function referrerWithCode() {
    const referrer = await makeUser();
    const code = await getOrCreateReferralCode({ userId: referrer.id });
    return { referrer, code };
  }

  it("attributes an already-signed-in user who hasn't raced yet", async () => {
    const { referrer, code } = await referrerWithCode();
    const user = await makeUser();

    const result = await redeemReferralCode({ user, referralCode: code });
    assert.deepEqual(result, { attributed: true });

    const ref = await getReferral(user.id);
    assert.ok(ref);
    assert.equal(ref.status, "PENDING");
    assert.equal(ref.referrerId, referrer.id);
  });

  it("refuses late attribution once the user has finished a race (already_raced)", async () => {
    const { code } = await referrerWithCode();
    const user = await makeUser();
    // Give the user a COMPLETED race participation.
    await seedRace({
      status: "COMPLETED",
      participants: [{ user, placement: 1, totalSteps: 3000 }],
    });

    const result = await redeemReferralCode({ user, referralCode: code });
    assert.deepEqual(result, { attributed: false, reason: "already_raced" });
    assert.equal(await prisma.referral.count(), 0);
  });

  it("refuses a second attribution for an already-attributed human", async () => {
    const { code } = await referrerWithCode();
    const referee = await makeUser();
    await recordReferral({ newUser: referee, referralCode: code });

    const result = await redeemReferralCode({ user: referee, referralCode: code });
    assert.deepEqual(result, { attributed: false, reason: "already_attributed" });
    assert.equal(await prisma.referral.count(), 1);
  });

  it("refuses self-referral, unknown codes, and invalid codes with reasons", async () => {
    const { referrer, code } = await referrerWithCode();

    const selfRes = await redeemReferralCode({ user: referrer, referralCode: code });
    assert.deepEqual(selfRes, { attributed: false, reason: "self_referral" });

    const stranger = await makeUser();
    const unknownRes = await redeemReferralCode({ user: stranger, referralCode: "BARA-ZZZZ" });
    assert.deepEqual(unknownRes, { attributed: false, reason: "unknown_code" });

    const invalidRes = await redeemReferralCode({ user: stranger, referralCode: "not-a-code" });
    assert.deepEqual(invalidRes, { attributed: false, reason: "invalid_code" });

    assert.equal(await prisma.referral.count(), 0);
  });
});

// ===========================================================================
// Read surfaces — preview (public) + status (dashboard) reflect the flow.
// ===========================================================================
describe("Read surfaces (preview + status)", () => {
  it("getReferralPreview returns the inviter + the referee reward; null for unknown", async () => {
    const referrer = await makeUser({ displayName: "Alice" });
    const code = await getOrCreateReferralCode({ userId: referrer.id });

    const preview = await getReferralPreview({ code });
    assert.equal(preview.inviterName, "Alice");
    assert.equal(preview.rewardCoins, REFEREE_REWARD_COINS);

    assert.equal(await getReferralPreview({ code: "BARA-ZZZZ" }), null);
  });

  it("getReferralStatus reflects counts, earnings, and friend stages after a reward", async () => {
    const referrer = await makeUser({ displayName: "Alice" });
    const code = await getOrCreateReferralCode({ userId: referrer.id });

    // One referee who completes a qualifying race (→ completed/REWARDED) and one
    // who's only joined (→ PENDING).
    const completed = await makeUser({ displayName: "Bob" });
    await recordReferral({ newUser: completed, referralCode: code });
    const joined = await makeUser({ displayName: "Carol" });
    await recordReferral({ newUser: joined, referralCode: code });

    const opponent = await makeUser();
    const race = await seedRace({
      participants: [
        { user: completed, placement: 2, totalSteps: 5000 },
        { user: opponent, placement: 1, totalSteps: 8000 },
      ],
    });
    const completeRace = buildCompleteRace({ eventBus: makeFakeBus() });
    await completeRace({ raceId: race.id, winnerUserId: opponent.id });

    const status = await getReferralStatus({ userId: referrer.id });
    assert.equal(status.referredCount, 2);
    assert.equal(status.completedCount, 1);
    assert.equal(status.coinsEarned, REFERRER_REWARD_COINS);

    const stages = Object.fromEntries(status.friends.map((f) => [f.displayName, f.stage]));
    assert.equal(stages.Bob, "completed");
    assert.equal(stages.Carol, "joined");
  });
});
