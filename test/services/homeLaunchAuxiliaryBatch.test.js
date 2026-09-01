const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createHomeLaunchAuxiliaryBatch,
} = require("../../src/modules/home/services/homeLaunchAuxiliaryBatch");

test("home launch auxiliary reads collapse concurrent users into set-based queries", async () => {
  const calls = { equipment: 0, cape: 0, steps: 0, claims: 0, friendships: 0, alerts: 0, threads: 0, summaries: 0 };
  const prisma = {
    userEquippedAccessory: { async findMany({ where }) {
      calls.equipment += 1;
      assert.deepEqual(new Set(where.userId.in), new Set(["u1", "u2"]));
      return [{ userId: "u2", slot: "HEAD", shopItem: { id: "hat" } }];
    } },
    shopItem: { async findFirst() {
      calls.cape += 1;
      return { id: "cape" };
    } },
    step: { async findMany({ where }) {
      calls.steps += 1;
      assert.deepEqual(new Set(where.userId.in), new Set(["u1", "u2"]));
      return [{ userId: "u1", date: new Date("2026-09-01"), steps: 7000 }];
    } },
    stepMilestoneClaim: { async findMany({ where }) {
      calls.claims += 1;
      assert.deepEqual(new Set(where.userId.in), new Set(["u1", "u2"]));
      return [{ userId: "u1", claimedDate: "2026-09-01", threshold: 5000 }];
    } },
    friendship: { async findMany() {
      calls.friendships += 1;
      return [{ id: "f1", status: "ACCEPTED", requesterId: "u1", addresseeId: "u2" }];
    } },
    inboxAlert: { async findMany() {
      calls.alerts += 1;
      return [{ userId: "u1", expiresAt: new Date("2026-09-01T00:10:00Z") }];
    } },
    feedbackThread: { async findMany() {
      calls.threads += 1;
      return [{ userId: "u2", expiresAt: new Date("2026-09-01T00:10:00Z") }];
    } },
    async $queryRaw() {
      calls.summaries += 1;
      return [{ userId: "u2", id: "summary", remainingMsAtLoad: 5000 }];
    },
  };
  const batch = createHomeLaunchAuxiliaryBatch();
  const [equipment1, equipment2, cape1, cape2, milestone1, milestone2, friends1, friends2, inbox1, inbox2, summary1, summary2] =
    await Promise.all([
      batch.loadEquipment({ prisma, userId: "u1" }),
      batch.loadEquipment({ prisma, userId: "u2" }),
      batch.loadCape({ prisma, cacheKey: "prod:characters:remote", where: {}, orderBy: [] }),
      batch.loadCape({ prisma, cacheKey: "prod:characters:remote", where: {}, orderBy: [] }),
      batch.loadMilestones({ prisma, userId: "u1", localDate: "2026-09-01" }),
      batch.loadMilestones({ prisma, userId: "u2", localDate: "2026-09-01" }),
      batch.loadFriendships({ prisma, userId: "u1", select: { id: true } }),
      batch.loadFriendships({ prisma, userId: "u2", select: { id: true } }),
      batch.loadInboxCounts({ prisma, userId: "u1", now: new Date("2026-09-01T00:00:00Z") }),
      batch.loadInboxCounts({ prisma, userId: "u2", now: new Date("2026-09-01T00:00:00Z") }),
      batch.loadGlobalEventSummary({ prisma, userId: "u1" }),
      batch.loadGlobalEventSummary({ prisma, userId: "u2" }),
    ]);
  assert.deepEqual(equipment1, []);
  assert.equal(equipment2[0].shopItem.id, "hat");
  assert.equal(cape1.id, "cape");
  assert.equal(cape2.id, "cape");
  assert.equal(milestone1.stepRecord.steps, 7000);
  assert.deepEqual(milestone1.claims, [{ userId: "u1", claimedDate: "2026-09-01", threshold: 5000 }]);
  assert.equal(milestone2.stepRecord, null);
  assert.deepEqual(milestone2.claims, []);
  assert.equal(friends1.length, 1);
  assert.equal(friends2.length, 1);
  assert.deepEqual(inbox1, { unreadCount: 1, supportThreadUnreadCount: 0 });
  assert.deepEqual(inbox2, { unreadCount: 0, supportThreadUnreadCount: 1 });
  assert.equal(summary1, null);
  assert.equal(summary2.id, "summary");
  assert.deepEqual(calls, { equipment: 1, cape: 1, steps: 1, claims: 1, friendships: 1, alerts: 1, threads: 1, summaries: 1 });
});
