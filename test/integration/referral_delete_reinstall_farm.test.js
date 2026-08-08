// Can a single person farm referral coins by looping
//
//   sign in with Apple → send own invite link → sign in with Google →
//   redeem it → finish a race → delete the account → repeat?
//
// The whole defence is DB constraints that must survive a HARD account delete,
// so this can only be answered end-to-end against the real Postgres. The
// existing referral suite's "reinstall" case never deletes the user, so the
// cascade behaviour on `Referral` (onDelete: Cascade) versus the abuse ledger
// `ReferralRewardGrant` (onDelete: SetNull) is exercised here for the first
// time.
//
// Runs against steps-tracker-integration (see `npm run test:integration`),
// never prod.

const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");

const { prisma, cleanDatabase, getSharedServer } = require("./setup");

const {
  REFERRER_REWARD_COINS,
  REFEREE_REWARD_COINS,
} = require("../../src/modules/social/referralRewards");

const {
  getOrCreateReferralCode,
} = require("../../src/modules/social/commands/getOrCreateReferralCode");
const {
  recordReferral,
} = require("../../src/modules/social/commands/recordReferral");
const {
  buildCompleteRace,
} = require("../../src/modules/races/commands/completeRace");
const {
  deleteUserAccount,
} = require("../../src/modules/users/commands/deleteUserAccount");

let seq = 0;

async function makeUser(overrides = {}) {
  seq += 1;
  return prisma.user.create({
    data: {
      appleId: overrides.appleId || `apple-farm-${seq}`,
      email: overrides.email || `farm-${seq}@example.com`,
      displayName: `Farmer ${seq}`,
      ...overrides,
    },
  });
}

async function seedRace({ participants }) {
  return prisma.race.create({
    data: {
      name: `Farm race ${(seq += 1)}`,
      targetSteps: 10000,
      status: "ACTIVE",
      participants: {
        create: participants.map((p) => ({
          userId: p.user.id,
          status: "ACCEPTED",
          placement: p.placement ?? null,
          totalSteps: p.totalSteps ?? 0,
        })),
      },
    },
  });
}

// Walk one full cycle: the referee finishes a qualifying (2-real-finisher)
// race, which is the moment the reward fires.
async function finishQualifyingRace(referee) {
  const opponent = await makeUser();
  const race = await seedRace({
    participants: [
      { user: referee, placement: 2, totalSteps: 5000 },
      { user: opponent, placement: 1, totalSteps: 8000 },
    ],
  });
  const completeRace = buildCompleteRace({
    eventBus: { emit() {} },
  });
  await completeRace({
    raceId: race.id,
    winnerUserId: opponent.id,
    participantUserIds: [referee.id, opponent.id],
  });
}

function referralCoinsOf(userId) {
  return prisma.coinTransaction.findMany({
    where: { userId, reason: "referral_reward" },
  });
}

before(async () => {
  await getSharedServer();
});

beforeEach(async () => {
  await cleanDatabase();
});

describe("referral farming via delete-and-recreate", () => {
  it("pays the first cycle, then NOTHING on any repeat with the same two humans", async () => {
    // The two provider identities the farmer controls. These are what the
    // guard is keyed on, and they are stable for a real person: Apple's `sub`
    // and Google's `sub` do not change across delete + reinstall.
    const APPLE_SUB = "apple-sub-stable-farmer";
    const GOOGLE_SUB = "google-sub-stable-farmer";

    // --- Cycle 1 ------------------------------------------------------
    const apple = await makeUser({ appleId: APPLE_SUB });
    const code = await getOrCreateReferralCode({ userId: apple.id });

    let google = await makeUser({
      appleId: null,
      googleSub: GOOGLE_SUB,
      email: "farmer-google@example.com",
    });
    await recordReferral({ newUser: google, referralCode: code });
    await finishQualifyingRace(google);

    assert.equal((await referralCoinsOf(apple.id)).length, 1);
    assert.equal((await referralCoinsOf(google.id)).length, 1);
    const cycle1Minted = REFERRER_REWARD_COINS + REFEREE_REWARD_COINS;

    // --- Delete the Google account and do it all again ----------------
    await deleteUserAccount({ userId: google.id });

    // The attribution row itself is gone: Referral cascades with the referee.
    assert.equal(await prisma.referral.count(), 0);
    // The abuse ledger is NOT gone. The deleted referee's row keeps only its
    // hash + role (userId SetNull'd, which is the privacy-safe part); the
    // referrer's row is untouched because that account still exists.
    const survivingGrants = await prisma.referralRewardGrant.findMany();
    assert.equal(survivingGrants.length, 2);
    const byRole = Object.fromEntries(survivingGrants.map((g) => [g.role, g]));
    assert.equal(byRole.REFEREE.userId, null);
    assert.equal(byRole.REFERRER.userId, apple.id);
    assert.ok(byRole.REFEREE.refereeSubHash);

    // --- Cycle 2: same human, same Google sub, brand-new account ------
    google = await makeUser({
      appleId: null,
      googleSub: GOOGLE_SUB,
      email: "farmer-google-again@example.com",
    });
    await recordReferral({ newUser: google, referralCode: code });
    // Attribution is allowed to re-happen (the unique slot was freed by the
    // cascade) — the payout is where it must die.
    assert.equal(await prisma.referral.count(), 1);

    await finishQualifyingRace(google);

    // Neither side earns a second time: @@unique([refereeSubHash, role])
    // collides before a coin mints.
    assert.equal(
      (await referralCoinsOf(apple.id)).length,
      1,
      "referrer must not be paid twice for the same human"
    );
    assert.equal(
      (await referralCoinsOf(google.id)).length,
      0,
      "the recreated referee must not be paid again"
    );
    assert.equal(await prisma.referralRewardGrant.count(), 2);

    // --- Cycle 3: loop it once more, still nothing --------------------
    await deleteUserAccount({ userId: google.id });
    google = await makeUser({
      appleId: null,
      googleSub: GOOGLE_SUB,
      email: "farmer-google-third@example.com",
    });
    await recordReferral({ newUser: google, referralCode: code });
    await finishQualifyingRace(google);

    assert.equal((await referralCoinsOf(apple.id)).length, 1);
    assert.equal((await referralCoinsOf(google.id)).length, 0);

    // Across three full cycles the program minted exactly one payout per role,
    // and only cycle 1's. The surviving ledger shows just the referrer's half:
    // the referee's coin rows were hard-deleted with their account (which is
    // also why the farmer keeps nothing on the referee side — the coins die
    // with the account they were paid into).
    const survivingReferralCoins = await prisma.coinTransaction.aggregate({
      where: { reason: "referral_reward" },
      _sum: { amount: true },
    });
    assert.equal(survivingReferralCoins._sum.amount, REFERRER_REWARD_COINS);
    assert.equal(cycle1Minted, REFERRER_REWARD_COINS + REFEREE_REWARD_COINS);
    assert.equal(await prisma.referralRewardGrant.count(), 2);
  });

  it("the SAME pair can still be paid once more by swapping roles", async () => {
    // The guard is keyed on the REFEREE's hash, so each identity can be
    // refereed exactly once. Two identities therefore yield two payouts total
    // before the loop is permanently dead — this is the real ceiling, and it
    // is what the farmer would actually reach for after the first test.
    const APPLE_SUB = "apple-sub-swap";
    const GOOGLE_SUB = "google-sub-swap";

    const apple = await makeUser({ appleId: APPLE_SUB });
    const appleCode = await getOrCreateReferralCode({ userId: apple.id });

    let google = await makeUser({
      appleId: null,
      googleSub: GOOGLE_SUB,
      email: "swap-google@example.com",
    });
    await recordReferral({ newUser: google, referralCode: appleCode });
    await finishQualifyingRace(google);
    assert.equal((await referralCoinsOf(google.id)).length, 1);

    // Now flip it: the Google account invites a *recreated* Apple account.
    const googleCode = await getOrCreateReferralCode({ userId: google.id });
    await deleteUserAccount({ userId: apple.id });

    const apple2 = await makeUser({
      appleId: APPLE_SUB,
      email: "swap-apple-again@example.com",
    });
    await recordReferral({ newUser: apple2, referralCode: googleCode });
    await finishQualifyingRace(apple2);

    // The Apple identity has never been a REFEREE before, so this pays.
    assert.equal(
      (await referralCoinsOf(apple2.id)).length,
      1,
      "role swap is the one remaining payout"
    );

    // ...and now BOTH identities are burned. A third cycle in either
    // direction mints nothing.
    await deleteUserAccount({ userId: google.id });
    const google2 = await makeUser({
      appleId: null,
      googleSub: GOOGLE_SUB,
      email: "swap-google-again@example.com",
    });
    const apple2Code = await getOrCreateReferralCode({ userId: apple2.id });
    await recordReferral({ newUser: google2, referralCode: apple2Code });
    await finishQualifyingRace(google2);

    assert.equal((await referralCoinsOf(google2.id)).length, 0);
    assert.equal(await prisma.referralRewardGrant.count(), 4);
  });
});
