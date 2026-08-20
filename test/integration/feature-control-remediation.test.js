const assert = require("node:assert/strict");
const { after, before, beforeEach, describe, it } = require("node:test");

const {
  cleanDatabase,
  disconnectDatabase,
  getSharedServer,
  prisma,
  request,
} = require("./setup");
const {
  remediateImposterInventory,
} = require("../../src/modules/powerups/services/imposterRetirementRemediation");
const {
  remediateLegacyBuyIns,
} = require("../../src/modules/races/services/legacyBuyInRemediation");
const { awardCoins } = require("../../src/shared/economy/awardCoins");

let server;
let identity = 0;

async function createUser(coins = 0) {
  const response = await request(server.baseUrl, "POST", "/auth/apple", {
    body: { identityToken: `cleanup-remediation-${++identity}` },
  });
  const body = await response.json();
  await prisma.user.update({ where: { id: body.user.id }, data: { coins } });
  return { id: body.user.id, coins };
}

describe("feature-control one-time remediations", () => {
  before(async () => { server = await getSharedServer(); });
  beforeEach(async () => { await cleanDatabase(); identity = 0; });
  after(async () => { await server.close(); await disconnectDatabase(); });

  it("retires five Imposter units, awards exactly 800, and reruns as a no-op", async () => {
    const users = await Promise.all([createUser(), createUser(), createUser(), createUser()]);
    const plan = {
      owners: [
        { userId: users[0].id, units: [{ source: "paid", amount: 300 }, { source: "free", amount: 75 }] },
        { userId: users[1].id, units: [{ source: "paid", amount: 275 }] },
        { userId: users[2].id, units: [{ source: "free", amount: 75 }] },
        { userId: users[3].id, units: [{ source: "free", amount: 75 }] },
      ],
    };
    await prisma.userPowerupItem.createMany({
      data: users.map((user, index) => ({ userId: user.id, powerupType: "IMPOSTER", quantity: index === 0 ? 2 : 1 })),
    });

    const first = await prisma.$transaction((tx) => remediateImposterInventory({ tx, plan }));
    assert.deepEqual(first, { alreadyApplied: false, unitsRemoved: 5, coinsAwarded: 800 });
    assert.equal(await prisma.coinTransaction.count({ where: { reason: "imposter_retirement" } }), 5);
    assert.equal((await prisma.coinTransaction.aggregate({ where: { reason: "imposter_retirement" }, _sum: { amount: true } }))._sum.amount, 800);
    assert.equal(await prisma.userPowerupItem.aggregate({ where: { powerupType: "IMPOSTER" }, _sum: { quantity: true } }).then((row) => row._sum.quantity), 0);

    const balances = await prisma.user.findMany({ where: { id: { in: users.map((user) => user.id) } }, select: { coins: true } });
    const second = await prisma.$transaction((tx) => remediateImposterInventory({ tx, plan }));
    assert.deepEqual(second, { alreadyApplied: true, unitsRemoved: 5, coinsAwarded: 800 });
    assert.deepEqual(await prisma.user.findMany({ where: { id: { in: users.map((user) => user.id) } }, select: { coins: true } }), balances);
    assert.equal(await prisma.coinTransaction.count({ where: { reason: "imposter_retirement" } }), 5);

    await awardCoins({
      userId: users[0].id,
      amount: 1,
      reason: "imposter_retirement",
      refId: "imposter-retirement:unexpected-extra",
    });
    await assert.rejects(
      prisma.$transaction((tx) => remediateImposterInventory({ tx, plan })),
      /exact five-row retirement ledger/,
    );
  });

  it("refuses a first Imposter apply when any retirement-reason ledger row exists", async () => {
    const users = await Promise.all([createUser(), createUser(), createUser(), createUser()]);
    const plan = {
      owners: [
        { userId: users[0].id, units: [{ source: "paid", amount: 300 }, { source: "free", amount: 75 }] },
        { userId: users[1].id, units: [{ source: "paid", amount: 275 }] },
        { userId: users[2].id, units: [{ source: "free", amount: 75 }] },
        { userId: users[3].id, units: [{ source: "free", amount: 75 }] },
      ],
    };
    await prisma.userPowerupItem.createMany({
      data: users.map((user, index) => ({
        userId: user.id,
        powerupType: "IMPOSTER",
        quantity: index === 0 ? 2 : 1,
      })),
    });
    await awardCoins({
      userId: users[0].id,
      amount: 1,
      reason: "imposter_retirement",
      refId: "imposter-retirement:unexpected-live-extra",
    });

    await assert.rejects(
      prisma.$transaction((tx) => remediateImposterInventory({ tx, plan })),
      /zero retirement-reason ledger rows/,
    );
    assert.equal(
      (await prisma.userPowerupItem.aggregate({
        where: { powerupType: "IMPOSTER" },
        _sum: { quantity: true },
      }))._sum.quantity,
      5,
    );
  });

  it("refunds only the exact 830 debit ledger, clears six uncharged markers, and reruns as a no-op", async () => {
    const users = await Promise.all(Array.from({ length: 7 }, () => createUser(1_000)));
    const completedRaceIds = [];
    const completedParticipants = [];
    for (let raceIndex = 0; raceIndex < 8; raceIndex += 1) {
      const race = await prisma.race.create({
        data: { creatorId: users[0].id, name: `Legacy completed ${raceIndex}`, targetSteps: 10_000, status: "COMPLETED", completedAt: new Date() },
      });
      completedRaceIds.push(race.id);
      for (let participantIndex = 0; participantIndex < 5; participantIndex += 1) {
        const sequence = raceIndex * 5 + participantIndex;
        const user = users[participantIndex];
        const participant = await prisma.raceParticipant.create({
          data: { raceId: race.id, userId: user.id, status: "ACCEPTED", buyInAmount: sequence === 39 ? 180 : 25, buyInStatus: "HELD" },
        });
        completedParticipants.push({ participantId: participant.id, userId: user.id, raceId: race.id, buyInAmount: participant.buyInAmount });
      }
    }
    const chargedDebits = [];
    const expectedRefunds = [];
    for (let index = 0; index < 36; index += 1) {
      const row = completedParticipants[index];
      const amount = index === 35 ? 130 : 20;
      const refId = `${row.raceId}:${row.userId}`;
      chargedDebits.push({ refId, userId: row.userId, amount: -amount });
      expectedRefunds.push({ refId, userId: row.userId, amount });
      await awardCoins({ userId: row.userId, amount: -amount, reason: "race_buy_in_hold", refId });
    }
    const pending = await prisma.race.create({
      data: { creatorId: users[0].id, name: "Legacy pending May lobby", targetSteps: 10_000, status: "PENDING" },
    });
    const pendingParticipants = [];
    for (const user of users.slice(5, 7)) {
      const participant = await prisma.raceParticipant.create({
        data: { raceId: pending.id, userId: user.id, status: "ACCEPTED", buyInAmount: 150, buyInStatus: "HELD" },
      });
      pendingParticipants.push({ participantId: participant.id, userId: user.id, raceId: pending.id, buyInAmount: 150 });
    }
    const plan = {
      completedRaceIds,
      completedParticipants,
      pendingRaceId: pending.id,
      pendingParticipants,
      chargedDebits,
      expectedRefunds,
    };

    await prisma.coinTransaction.updateMany({
      where: { reason: "race_buy_in_hold", refId: chargedDebits[0].refId },
      data: { amount: -21 },
    });
    await assert.rejects(
      prisma.$transaction((tx) => remediateLegacyBuyIns({ tx, plan })),
      /debit ledger does not exactly match/,
    );
    await prisma.coinTransaction.updateMany({
      where: { reason: "race_buy_in_hold", refId: chargedDebits[0].refId },
      data: { amount: chargedDebits[0].amount },
    });
    await prisma.coinTransaction.updateMany({
      where: { reason: "race_buy_in_hold", refId: chargedDebits[0].refId },
      data: { userId: users[6].id },
    });
    await assert.rejects(
      prisma.$transaction((tx) => remediateLegacyBuyIns({ tx, plan })),
      /debit ledger does not exactly match/,
    );
    await prisma.coinTransaction.updateMany({
      where: { reason: "race_buy_in_hold", refId: chargedDebits[0].refId },
      data: { userId: chargedDebits[0].userId },
    });

    const first = await prisma.$transaction((tx) => remediateLegacyBuyIns({ tx, plan }));
    assert.deepEqual(first, { alreadyApplied: false, refundedCoins: 830, refundedParticipants: 36, unchargedParticipants: 6 });
    assert.equal((await prisma.coinTransaction.aggregate({ where: { reason: "race_buy_in_refund" }, _sum: { amount: true }, _count: { _all: true } }))._sum.amount, 830);
    assert.equal(await prisma.raceParticipant.count({ where: { id: { in: completedParticipants.slice(0, 36).map((row) => row.participantId) }, buyInStatus: "REFUNDED" } }), 36);
    assert.equal(await prisma.raceParticipant.count({ where: { id: { in: [...completedParticipants.slice(36).map((row) => row.participantId), ...pendingParticipants.map((row) => row.participantId)] }, buyInStatus: "NONE" } }), 6);
    assert.equal((await prisma.race.findUnique({ where: { id: pending.id } })).status, "CANCELLED");

    const balanceSnapshot = await prisma.user.findMany({ where: { id: { in: users.map((user) => user.id) } }, orderBy: { id: "asc" }, select: { id: true, coins: true } });
    const second = await prisma.$transaction((tx) => remediateLegacyBuyIns({ tx, plan }));
    assert.equal(second.alreadyApplied, true);
    assert.deepEqual(await prisma.user.findMany({ where: { id: { in: users.map((user) => user.id) } }, orderBy: { id: "asc" }, select: { id: true, coins: true } }), balanceSnapshot);
    assert.equal(await prisma.coinTransaction.count({ where: { reason: "race_buy_in_refund" } }), 36);

    const mismatchedPlan = structuredClone(plan);
    [mismatchedPlan.chargedDebits[0].amount, mismatchedPlan.chargedDebits[35].amount] =
      [mismatchedPlan.chargedDebits[35].amount, mismatchedPlan.chargedDebits[0].amount];
    await assert.rejects(
      prisma.$transaction((tx) => remediateLegacyBuyIns({ tx, plan: mismatchedPlan })),
      /exact refId, userId, and amount pairs/,
    );
  });
});
