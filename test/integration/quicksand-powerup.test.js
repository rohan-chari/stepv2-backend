const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer, createTestUser } = require("./setup");
const { RaceActiveEffect } = require("../../src/modules/powerups/models/raceActiveEffect");
let server;
const P4 = { "X-Client-Features": "powerups4", "X-Release-Channel": "testflight" };

async function activeRace(users) {
  for (const user of users.slice(1)) {
    const sent = await request(server.baseUrl, "POST", "/friends/request", { token: users[0].token, body: { addresseeId: user.user.id } });
    const friendshipId = (await sent.json()).friendship.id;
    await request(server.baseUrl, "PUT", `/friends/request/${friendshipId}`, { token: user.token, body: { accept: true } });
  }
  const made = await request(server.baseUrl, "POST", "/races", { token: users[0].token, body: { name: "Quicksand Integration", maxDurationDays: 7, powerupsEnabled: true, powerupStepInterval: 5000 } });
  const raceId = (await made.json()).race.id;
  await request(server.baseUrl, "POST", `/races/${raceId}/invite`, { token: users[0].token, body: { inviteeIds: users.slice(1).map((u) => u.user.id) } });
  for (const user of users.slice(1)) await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, { token: user.token, body: { accept: true } });
  const started = await request(server.baseUrl, "POST", `/races/${raceId}/start`, { token: users[0].token });
  assert.equal(started.status, 200, JSON.stringify(await started.json()));
  return raceId;
}

async function held(raceId, userId, earnedAtSteps = Math.floor(Math.random() * 1000000000)) {
  const participant = await prisma.raceParticipant.findFirst({ where: { raceId, userId } });
  return prisma.racePowerup.create({ data: { raceId, participantId: participant.id, userId, type: "QUICKSAND", rarity: "RARE", status: "HELD", earnedAtSteps } });
}

describe("Quicksand real HTTP contract", () => {
  before(async () => { server = await getSharedServer(); });
  beforeEach(async () => { await cleanDatabase(); });

  it("purchases for 300, redeems, and resolves three ordered targets independently", async () => {
    const users = await Promise.all([0, 1, 2, 3].map(() => createTestUser()));
    await prisma.user.update({ where: { id: users[0].user.id }, data: { coins: 300 } });
    await prisma.powerupShopItem.upsert({ where: { sku: "POWERUP_QUICKSAND" }, update: {}, create: { sku: "POWERUP_QUICKSAND", name: "Quicksand", description: "Freeze three", priceCoins: 300, powerupType: "QUICKSAND", active: true, testOnly: true, sortOrder: 99 } });
    const purchase = await request(server.baseUrl, "POST", "/shop/powerups/purchase", { token: users[0].token, headers: { ...P4, "Idempotency-Key": "quicksand-buy-1" }, body: { powerupType: "QUICKSAND" } });
    assert.equal(purchase.status, 200);
    assert.equal((await purchase.json()).purchase.coinsSpent, 300);
    const raceId = await activeRace(users);
    const redeem = await request(server.baseUrl, "POST", `/races/${raceId}/powerups/redeem`, { token: users[0].token, headers: P4, body: { powerupType: "QUICKSAND" } });
    const redeemBody = await redeem.json();
    assert.equal(redeem.status, 200, JSON.stringify(redeemBody));
    const powerupId = redeemBody.result.powerup.id;
    const shielded = await prisma.raceParticipant.findFirst({ where: { raceId, userId: users[2].user.id } });
    const socks = await prisma.racePowerup.create({ data: {
      raceId, participantId: shielded.id, userId: users[2].user.id,
      type: "COMPRESSION_SOCKS", rarity: "UNCOMMON", status: "USED",
      earnedAtSteps: 87654321, usedAt: new Date(),
    } });
    await RaceActiveEffect.create({ raceId, targetParticipantId: shielded.id, targetUserId: users[2].user.id, sourceUserId: users[2].user.id, powerupId: socks.id, type: "COMPRESSION_SOCKS", startsAt: new Date(), expiresAt: new Date(Date.now() + 3600000) });
    const ids = users.slice(1).map((u) => u.user.id);
    const used = await request(server.baseUrl, "POST", `/races/${raceId}/powerups/${powerupId}/use`, { token: users[0].token, headers: P4, body: { targetUserIds: ids } });
    assert.equal(used.status, 200);
    const result = (await used.json()).result;
    assert.equal(result.outcome, "PARTIAL"); assert.equal(result.durationMs, 3600000);
    assert.deepEqual(result.targetResults.map((r) => [r.targetUserId, r.outcome]), [[ids[0], "APPLIED"], [ids[1], "BLOCKED"], [ids[2], "APPLIED"]]);
  });

  it("rejects malformed and legacy requests without consuming", async () => {
    const users = await Promise.all([createTestUser(), createTestUser()]);
    const raceId = await activeRace(users); const item = await held(raceId, users[0].user.id);
    for (const [headers, body] of [[P4, { targetUserIds: [] }], [P4, { targetUserIds: [users[1].user.id, users[1].user.id] }], [{}, { targetUserIds: [users[1].user.id] }]]) {
      const res = await request(server.baseUrl, "POST", `/races/${raceId}/powerups/${item.id}/use`, { token: users[0].token, headers, body });
      assert.equal(res.status, 400);
    }
    assert.equal((await prisma.racePowerup.findUnique({ where: { id: item.id } })).status, "HELD");
  });

  it("serializes concurrent freezes and preserves the losing item", async () => {
    const users = await Promise.all([createTestUser(), createTestUser()]);
    const raceId = await activeRace(users); const [a, b] = await Promise.all([held(raceId, users[0].user.id), held(raceId, users[0].user.id)]);
    const use = (id) => request(server.baseUrl, "POST", `/races/${raceId}/powerups/${id}/use`, { token: users[0].token, headers: P4, body: { targetUserIds: [users[1].user.id] } });
    const responses = await Promise.all([use(a.id), use(b.id)]);
    assert.deepEqual(responses.map((r) => r.status).sort(), [200, 400]);
    const rows = await prisma.racePowerup.findMany({ where: { id: { in: [a.id, b.id] } } });
    assert.deepEqual(rows.map((r) => r.status).sort(), ["HELD", "USED"]);
    assert.equal(await prisma.raceActiveEffect.count({ where: { raceId, type: "QUICKSAND", status: "ACTIVE" } }), 1);
  });
});
