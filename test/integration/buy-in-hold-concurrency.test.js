const assert = require("node:assert/strict");
const test = require("node:test");

const { prisma } = require("../../src/db");
const {
  cleanDatabase,
  createTestUser,
  request,
  getSharedServer,
} = require("./setup");

// Buy-in hold concurrency (audit Phase 3 follow-up): the affordability check
// (ensureUserCanAfford) and the hold debit used to be non-atomic, so two
// simultaneous paid joins racing the same wallet could both pass the check and
// drive the balance negative. The hold now goes through the balance-guarded
// deductCoinsAtomic: exactly one of two competing holds may win a wallet that
// covers only one.
test("buy-in hold concurrency", async (t) => {
  let baseUrl;

  t.before(async () => {
    ({ baseUrl } = await getSharedServer());
  });

  t.beforeEach(async () => {
    await cleanDatabase();
  });

  function createPaidPublicRace(name) {
    return prisma.race.create({
      data: {
        creatorId: null,
        name,
        targetSteps: 0,
        isPublic: true,
        timeBased: true,
        timezone: "America/New_York",
        maxParticipants: 500,
        maxDurationDays: 1,
        buyInAmount: 100,
        status: "PENDING",
      },
      select: { id: true },
    });
  }

  await t.test(
    "two simultaneous paid joins with a wallet covering exactly one: one succeeds, balance never negative",
    async () => {
      const { user, token } = await createTestUser({ coins: 100 });
      const raceA = await createPaidPublicRace("Paid Race A");
      const raceB = await createPaidPublicRace("Paid Race B");

      const [resA, resB] = await Promise.all([
        request(baseUrl, "POST", `/races/${raceA.id}/join`, { token }),
        request(baseUrl, "POST", `/races/${raceB.id}/join`, { token }),
      ]);

      const statuses = [resA.status, resB.status].sort();
      const bodies = await Promise.all([resA.json(), resB.json()]);

      const successes = statuses.filter((s) => s >= 200 && s < 300);
      assert.equal(
        successes.length,
        1,
        `exactly one join must win (got ${statuses.join(",")}: ${JSON.stringify(bodies)})`
      );

      const loser = bodies[resA.status >= 400 ? 0 : 1];
      assert.equal(loser.error, "You do not have enough coins for this buy-in");

      const wallet = await prisma.user.findUnique({ where: { id: user.id } });
      assert.equal(wallet.coins, 0, "winner debits exactly one buy-in");
      assert.ok(wallet.coins >= 0, "balance must never go negative");

      const holds = await prisma.coinTransaction.findMany({
        where: { userId: user.id, reason: "race_buy_in_hold" },
      });
      assert.equal(holds.length, 1, "exactly one hold ledger row");
      assert.equal(holds[0].amount, -100);
    }
  );

  await t.test(
    "duplicate hold for the same race replays as a no-op (idempotent refId), no double debit",
    async () => {
      const { user, token } = await createTestUser({ coins: 300 });
      const race = await createPaidPublicRace("Paid Race C");

      const first = await request(baseUrl, "POST", `/races/${race.id}/join`, { token });
      assert.ok(first.status >= 200 && first.status < 300);

      // A second join attempt is rejected as already-joined BEFORE any coin
      // work; the wallet and ledger must be untouched.
      const second = await request(baseUrl, "POST", `/races/${race.id}/join`, { token });
      assert.ok(second.status >= 400);

      const wallet = await prisma.user.findUnique({ where: { id: user.id } });
      assert.equal(wallet.coins, 200);
      const holds = await prisma.coinTransaction.findMany({
        where: { userId: user.id, reason: "race_buy_in_hold" },
      });
      assert.equal(holds.length, 1);
    }
  );
});
