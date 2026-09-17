const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer, createTestUser } = require("./setup");
const { RaceActiveEffect } = require("../../src/modules/powerups/models/raceActiveEffect");
const { buildHistoricalRaceReconciliationWorker } = require("../../src/modules/races/jobs/historicalRaceReconciliation");
const { StepSample } = require("../../src/modules/steps/models/stepSample");
const { computeEffectModifiers } = require("../../src/modules/races/services/effectiveStepScoring");
const { computeHitchhikeCopiedSteps } = require("../../src/modules/powerups/hitchhikeCopies");
let server;
const P4 = { "X-Client-Features": "powerups4", "X-Release-Channel": "testflight" };

// isPublic keeps the race ineligible for private-race auto-start, so this
// helper keeps starting the race through the manual POST /races/:id/start.
async function activeRace(users) {
  for (const user of users.slice(1)) {
    const sent = await request(server.baseUrl, "POST", "/friends/request", { token: users[0].token, body: { addresseeId: user.user.id } });
    const friendshipId = (await sent.json()).friendship.id;
    await request(server.baseUrl, "PUT", `/friends/request/${friendshipId}`, { token: user.token, body: { accept: true } });
  }
  const made = await request(server.baseUrl, "POST", "/races", { token: users[0].token, body: { name: "Quicksand Integration", maxDurationDays: 7, powerupsEnabled: true, powerupStepInterval: 5000, isPublic: true } });
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

async function makeGold(userId) {
  const identity = await prisma.billingIdentity.create({ data: { userId } });
  await prisma.billingSubscription.create({
    data: {
      id: `quicksand-gold-${userId}`,
      identityId: identity.id,
      productId: "bara_plus_weekly_v1",
      startsAt: new Date(),
      periodStartsAt: new Date(),
      accessUntil: new Date(Date.now() + 86400000),
      givesAccess: true,
      benefitContract: "bara_gold_v1",
      observedAt: new Date(),
    },
  });
}

const HISTORICAL_START = new Date("2026-09-16T10:00:00.000Z");
const HISTORICAL_END = new Date("2026-09-16T23:00:00.000Z");

async function historicalFixture({ status = "COMPLETED", users = 1 } = {}) {
  const accounts = await Promise.all(Array.from({ length: users }, () => createTestUser()));
  const race = await prisma.race.create({
    data: {
      creatorId: accounts[0].user.id,
      name: "Dedicated Quicksand history",
      targetSteps: 100000,
      status,
      startedAt: HISTORICAL_START,
      endsAt: HISTORICAL_END,
      completedAt: status === "COMPLETED" ? HISTORICAL_END : null,
      timezone: "UTC",
      powerupsEnabled: true,
      timeBased: true,
      maxDurationDays: 1,
    },
  });
  const participants = [];
  for (const account of accounts) {
    const participant = await prisma.raceParticipant.create({
      data: {
        raceId: race.id,
        userId: account.user.id,
        status: "ACCEPTED",
        joinedAt: HISTORICAL_START,
        totalSteps: 0,
        rawSteps: 0,
      },
    });
    await prisma.userScoringInputVersion.create({
      data: { userId: account.user.id, generation: 2 },
    });
    participants.push(participant);
  }
  return { accounts, race, participants };
}

async function historicalEffect(data, participantIndex, type, startsAt, expiresAt, metadata = {}, sourceParticipantIndex = 0) {
  const account = data.accounts[participantIndex];
  const participant = data.participants[participantIndex];
  const source = data.accounts[sourceParticipantIndex];
  const powerup = await prisma.racePowerup.create({
    data: {
      raceId: data.race.id,
      participantId: data.participants[sourceParticipantIndex].id,
      userId: source.user.id,
      type,
      rarity: "RARE",
      status: "USED",
    },
  });
  return prisma.raceActiveEffect.create({
    data: {
      raceId: data.race.id,
      targetParticipantId: participant.id,
      targetUserId: account.user.id,
      sourceUserId: source.user.id,
      powerupId: powerup.id,
      type,
      status: "EXPIRED",
      startsAt,
      expiresAt,
      metadata,
    },
  });
}

async function historicalSamples(userId, rows) {
  await prisma.stepSample.createMany({
    data: rows.map(([periodStart, periodEnd, steps]) => ({
      userId,
      periodStart,
      periodEnd,
      steps,
      sourceName: "healthkit",
    })),
  });
}

async function queueHistorical(data, changedStart = HISTORICAL_START, changedEnd = HISTORICAL_END, generation = 2, userIndex = 0) {
  const account = data.accounts[userIndex];
  return prisma.historicalRaceReconciliationIntent.upsert({
    where: { raceId_userId: { raceId: data.race.id, userId: account.user.id } },
    create: {
      raceId: data.race.id,
      userId: account.user.id,
      changedStart,
      changedEnd,
      requestedSourceGeneration: generation,
      phase2Eligible: true,
      createdAt: new Date("2026-09-16T23:01:00.000Z"),
    },
    update: {
      changedStart,
      changedEnd,
      requestedSourceGeneration: generation,
      phase2Eligible: true,
      status: "QUEUED",
      availableAt: new Date("2026-09-16T23:01:00.000Z"),
    },
  });
}

async function reconcileHistorical() {
  return buildHistoricalRaceReconciliationWorker({
    now: () => new Date("2026-09-16T23:02:00.000Z"),
    logger: { log() {}, warn() {}, error(error) { throw error; } },
  }).runOnce();
}

async function seedQuicksandCatalog() {
  await prisma.powerupShopItem.upsert({
    where: { sku: "POWERUP_QUICKSAND" },
    update: { active: true, dailyRewardEligible: true, testOnly: false },
    create: {
      sku: "POWERUP_QUICKSAND",
      name: "Quicksand",
      description: "Freeze three",
      priceCoins: 300,
      powerupType: "QUICKSAND",
      active: true,
      testOnly: false,
      dailyRewardEligible: true,
      sortOrder: 99,
    },
  });
}

describe("Quicksand real HTTP contract", () => {
  before(async () => { server = await getSharedServer(); });
  beforeEach(async () => { await cleanDatabase(); });

  it("purchases for 300, redeems, and resolves three ordered targets independently", async () => {
    const users = await Promise.all([0, 1, 2, 3].map(() => createTestUser()));
    await makeGold(users[0].user.id);
    await prisma.user.update({ where: { id: users[0].user.id }, data: { coins: 300 } });
    await prisma.powerupShopItem.upsert({ where: { sku: "POWERUP_QUICKSAND" }, update: {}, create: { sku: "POWERUP_QUICKSAND", name: "Quicksand", description: "Freeze three", priceCoins: 300, powerupType: "QUICKSAND", active: true, testOnly: true, sortOrder: 99 } });
    const purchase = await request(server.baseUrl, "POST", "/shop/powerups/purchase", { token: users[0].token, headers: { ...P4, "Idempotency-Key": "quicksand-buy-1" }, body: { powerupType: "QUICKSAND" } });
    assert.equal(purchase.status, 200);
    assert.equal((await purchase.json()).purchase.coinsSpent, 255, "Gold receives the 15% member discount");
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
    const effects = await prisma.raceActiveEffect.findMany({ where: { raceId, type: "QUICKSAND" }, orderBy: { targetUserId: "asc" } });
    assert.equal(effects.length, 2);
    for (const effect of effects) {
      assert.equal(effect.sourceUserId, users[0].user.id);
      assert.equal(effect.status, "ACTIVE");
      assert.equal(effect.expiresAt.getTime() - effect.startsAt.getTime(), 3600000);
      assert.equal(effect.metadata.stepsAtFreezeStart, 0);
    }
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

  it("rejects self, cross-race, and already-frozen targets without consuming", async () => {
    const users = await Promise.all([createTestUser(), createTestUser(), createTestUser()]);
    const raceId = await activeRace(users.slice(0, 2));
    const otherRaceId = await activeRace([users[0], users[2]]);
    const self = await held(raceId, users[0].user.id);
    const selfRes = await request(server.baseUrl, "POST", `/races/${raceId}/powerups/${self.id}/use`, { token: users[0].token, headers: P4, body: { targetUserIds: [users[0].user.id] } });
    assert.equal(selfRes.status, 400);
    assert.equal((await selfRes.json()).code, "INVALID_TARGETS");

    const crossRace = await held(raceId, users[0].user.id);
    const crossRes = await request(server.baseUrl, "POST", `/races/${raceId}/powerups/${crossRace.id}/use`, { token: users[0].token, headers: P4, body: { targetUserIds: [users[2].user.id] } });
    assert.equal(crossRes.status, 400);
    assert.equal((await crossRes.json()).code, "INVALID_TARGET");

    const first = await held(raceId, users[0].user.id);
    const firstRes = await request(server.baseUrl, "POST", `/races/${raceId}/powerups/${first.id}/use`, { token: users[0].token, headers: P4, body: { targetUserIds: [users[1].user.id] } });
    assert.equal(firstRes.status, 200);
    const second = await held(raceId, users[0].user.id);
    const secondRes = await request(server.baseUrl, "POST", `/races/${raceId}/powerups/${second.id}/use`, { token: users[0].token, headers: P4, body: { targetUserIds: [users[1].user.id] } });
    assert.equal(secondRes.status, 400);
    assert.equal((await secondRes.json()).code, "TARGET_ALREADY_FROZEN");
    assert.equal((await prisma.racePowerup.findUnique({ where: { id: second.id } })).status, "HELD");
    assert.ok(otherRaceId);
  });

  it("rejects a nonexistent target and an inactive race without consuming", async () => {
    const users = await Promise.all([createTestUser(), createTestUser()]);
    const raceId = await activeRace(users);
    const missing = await held(raceId, users[0].user.id);
    const missingResponse = await request(server.baseUrl, "POST", `/races/${raceId}/powerups/${missing.id}/use`, {
      token: users[0].token, headers: P4, body: { targetUserIds: ["00000000-0000-0000-0000-000000000000"] },
    });
    assert.equal(missingResponse.status, 400);
    assert.equal((await missingResponse.json()).code, "INVALID_TARGET");
    assert.equal((await prisma.racePowerup.findUniqueOrThrow({ where: { id: missing.id } })).status, "HELD");

    const inactive = await held(raceId, users[0].user.id);
    await prisma.race.update({ where: { id: raceId }, data: { status: "COMPLETED", completedAt: new Date() } });
    const inactiveResponse = await request(server.baseUrl, "POST", `/races/${raceId}/powerups/${inactive.id}/use`, {
      token: users[0].token, headers: P4, body: { targetUserIds: [users[1].user.id] },
    });
    assert.equal(inactiveResponse.status, 400);
    const inactiveBody = await inactiveResponse.json();
    assert.match(String(inactiveBody.code || inactiveBody.error || ""), /RACE|ACTIVE|ended/i);
    assert.equal((await prisma.racePowerup.findUniqueOrThrow({ where: { id: inactive.id } })).status, "HELD");
  });

  it("rejects a second source targeting the same frozen participant", async () => {
    const users = await Promise.all([createTestUser(), createTestUser(), createTestUser()]);
    const raceId = await activeRace(users);
    const first = await held(raceId, users[0].user.id);
    const second = await held(raceId, users[1].user.id);
    const firstResponse = await request(server.baseUrl, "POST", `/races/${raceId}/powerups/${first.id}/use`, {
      token: users[0].token, headers: P4, body: { targetUserIds: [users[2].user.id] },
    });
    assert.equal(firstResponse.status, 200);
    const secondResponse = await request(server.baseUrl, "POST", `/races/${raceId}/powerups/${second.id}/use`, {
      token: users[1].token, headers: P4, body: { targetUserIds: [users[2].user.id] },
    });
    assert.equal(secondResponse.status, 400);
    assert.equal((await secondResponse.json()).code, "TARGET_ALREADY_FROZEN");
    assert.equal((await prisma.racePowerup.findUniqueOrThrow({ where: { id: first.id } })).status, "USED");
    assert.equal((await prisma.racePowerup.findUniqueOrThrow({ where: { id: second.id } })).status, "HELD");
    assert.equal(await prisma.raceActiveEffect.count({ where: { raceId, type: "QUICKSAND" } }), 1);
  });

  it("records exact historical before, during, and after freeze boundaries", async () => {
    const data = await historicalFixture();
    const effect = await historicalEffect(
      data, 0, "QUICKSAND",
      new Date("2026-09-16T10:00:00Z"),
      new Date("2026-09-16T12:00:00Z"),
      { stepsAtFreezeStart: 0 },
    );
    await historicalSamples(data.accounts[0].user.id, [
      [new Date("2026-09-16T09:59:00Z"), new Date("2026-09-16T10:00:00Z"), 100],
      [new Date("2026-09-16T10:00:00Z"), new Date("2026-09-16T10:30:00Z"), 100],
      [new Date("2026-09-16T10:30:00Z"), new Date("2026-09-16T11:30:00Z"), 200],
      [new Date("2026-09-16T11:30:00Z"), new Date("2026-09-16T12:00:00Z"), 100],
      [new Date("2026-09-16T12:00:00Z"), new Date("2026-09-16T12:30:00Z"), 100],
    ]);
    await queueHistorical(data);
    assert.equal((await reconcileHistorical()).corrected, 1);
    const projection = await prisma.historicalEffectContribution.findFirstOrThrow({ where: { effectId: effect.id } });
    assert.equal(projection.currentDeltaSteps, -400, "only the 400 steps inside [10:00,12:00) are frozen");
  });

  it("preserves partial-overlap semantics at the start and expiry boundaries", async () => {
    const data = await historicalFixture();
    const effect = await historicalEffect(
      data, 0, "QUICKSAND",
      new Date("2026-09-16T10:00:00Z"),
      new Date("2026-09-16T12:00:00Z"),
      { stepsAtFreezeStart: 0 },
    );
    await historicalSamples(data.accounts[0].user.id, [
      [new Date("2026-09-16T09:30:00Z"), new Date("2026-09-16T10:30:00Z"), 600],
      [new Date("2026-09-16T11:30:00Z"), new Date("2026-09-16T12:30:00Z"), 600],
    ]);
    await queueHistorical(data);
    assert.equal((await reconcileHistorical()).corrected, 1);
    const projection = await prisma.historicalEffectContribution.findFirstOrThrow({ where: { effectId: effect.id } });
    assert.equal(projection.currentDeltaSteps, -600, "each half-overlapping sample contributes only its in-window half");
  });

  it("is invariant to one large, several small, or many tiny samples", async () => {
    const cases = [
      [[new Date("2026-09-16T10:00:00Z"), new Date("2026-09-16T11:00:00Z"), 1000]],
      Array.from({ length: 10 }, (_, index) => [
        new Date(Date.parse("2026-09-16T10:00:00Z") + index * 6 * 60 * 1000),
        new Date(Date.parse("2026-09-16T10:00:00Z") + (index + 1) * 6 * 60 * 1000),
        100,
      ]),
      Array.from({ length: 1000 }, (_, index) => [
        new Date(Date.parse("2026-09-16T10:00:00Z") + index * 3600),
        new Date(Date.parse("2026-09-16T10:00:00Z") + (index + 1) * 3600),
        1,
      ]),
    ];
    const projections = [];
    for (const rows of cases) {
      const data = await historicalFixture();
      const effect = await historicalEffect(
        data, 0, "QUICKSAND",
        new Date("2026-09-16T10:00:00Z"),
        new Date("2026-09-16T11:00:00Z"),
        { stepsAtFreezeStart: 0 },
      );
      await historicalSamples(data.accounts[0].user.id, rows);
      await queueHistorical(data);
      await reconcileHistorical();
      const projection = await prisma.historicalEffectContribution.findFirstOrThrow({ where: { effectId: effect.id } });
      projections.push(projection.currentDeltaSteps);
    }
    assert.deepEqual(projections, [-1000, -1000, -1000]);
  });

  it("reconciles both upward and downward late historical corrections without double application", async () => {
    const data = await historicalFixture();
    const effect = await historicalEffect(
      data, 0, "QUICKSAND", HISTORICAL_START,
      new Date("2026-09-16T11:00:00Z"), { stepsAtFreezeStart: 0 },
    );
    const row = [HISTORICAL_START, new Date("2026-09-16T11:00:00Z"), 800];
    await historicalSamples(data.accounts[0].user.id, [row]);
    await queueHistorical(data);
    assert.equal((await reconcileHistorical()).corrected, 1);
    assert.equal((await prisma.historicalEffectContribution.findFirstOrThrow({ where: { effectId: effect.id } })).currentDeltaSteps, -800);

    await prisma.stepSample.updateMany({ where: { userId: data.accounts[0].user.id }, data: { steps: 1000 } });
    await prisma.userScoringInputVersion.update({ where: { userId: data.accounts[0].user.id }, data: { generation: 3 } });
    await queueHistorical(data, HISTORICAL_START, HISTORICAL_END, 3);
    assert.equal((await reconcileHistorical()).corrected, 1);
    assert.equal((await prisma.historicalEffectContribution.findFirstOrThrow({ where: { effectId: effect.id } })).currentDeltaSteps, -1000);

    await prisma.stepSample.updateMany({ where: { userId: data.accounts[0].user.id }, data: { steps: 600 } });
    await prisma.userScoringInputVersion.update({ where: { userId: data.accounts[0].user.id }, data: { generation: 4 } });
    await queueHistorical(data, HISTORICAL_START, HISTORICAL_END, 4);
    assert.equal((await reconcileHistorical()).corrected, 1);
    assert.equal((await prisma.historicalEffectContribution.findFirstOrThrow({ where: { effectId: effect.id } })).currentDeltaSteps, -600);
    assert.equal(await prisma.historicalEffectCorrection.count({ where: { projectionId: (await prisma.historicalEffectContribution.findFirstOrThrow({ where: { effectId: effect.id } })).id } }), 3);
    assert.equal((await reconcileHistorical()).claimed, 0, "a repeated reconciliation is a no-op");
  });

  it("uses freeze precedence over Runner's High for the same target window", async () => {
    const data = await historicalFixture();
    const quicksand = await historicalEffect(data, 0, "QUICKSAND", HISTORICAL_START, new Date("2026-09-16T11:00:00Z"), { stepsAtFreezeStart: 0 });
    const runnersHigh = await historicalEffect(data, 0, "RUNNERS_HIGH", HISTORICAL_START, new Date("2026-09-16T11:00:00Z"), { stepsAtBuffStart: 0 });
    await historicalSamples(data.accounts[0].user.id, [[HISTORICAL_START, new Date("2026-09-16T11:00:00Z"), 1000]]);
    const modifiers = await computeEffectModifiers(
      [quicksand, runnersHigh], 1000, data.accounts[0].user.id, StepSample, true, null,
      new Date("2026-09-16T11:00:00Z"),
    );
    assert.equal(modifiers.frozenSteps, 1000, "Quicksand freeze precedence cancels Runner's High in the overlap");
    assert.equal(modifiers.buffedSteps, 0, "Runner's High contributes no boost while frozen");
  });

  it("keeps sequential Quicksand windows separate and prevents expiry bleed", async () => {
    const data = await historicalFixture();
    const first = await historicalEffect(data, 0, "QUICKSAND", new Date("2026-09-16T10:00:00Z"), new Date("2026-09-16T11:00:00Z"), { stepsAtFreezeStart: 0 });
    const second = await historicalEffect(data, 0, "QUICKSAND", new Date("2026-09-16T12:00:00Z"), new Date("2026-09-16T13:00:00Z"), { stepsAtFreezeStart: 0 });
    await historicalSamples(data.accounts[0].user.id, [
      [new Date("2026-09-16T10:00:00Z"), new Date("2026-09-16T11:00:00Z"), 100],
      [new Date("2026-09-16T11:00:00Z"), new Date("2026-09-16T12:00:00Z"), 200],
      [new Date("2026-09-16T12:00:00Z"), new Date("2026-09-16T13:00:00Z"), 300],
      [new Date("2026-09-16T13:00:00Z"), new Date("2026-09-16T14:00:00Z"), 400],
    ]);
    await queueHistorical(data);
    await reconcileHistorical();
    const rows = await prisma.historicalEffectContribution.findMany({ where: { effectId: { in: [first.id, second.id] } } });
    assert.equal(rows.find((row) => row.effectId === first.id).currentDeltaSteps, -100);
    assert.equal(rows.find((row) => row.effectId === second.id).currentDeltaSteps, -300);
  });

  it("documents Quicksand plus Hitchhike as post-effect target scoring", async () => {
    const data = await historicalFixture({ users: 2 });
    const target = data.participants[1];
    const quicksand = await historicalEffect(data, 1, "QUICKSAND", HISTORICAL_START, new Date("2026-09-16T11:00:00Z"), { stepsAtFreezeStart: 0 });
    const hitchhike = await historicalEffect(data, 1, "HITCHHIKE", HISTORICAL_START, new Date("2026-09-16T11:00:00Z"), { copyRatio: 0.5, scoringVersion: 2 }, 0);
    await historicalSamples(data.accounts[1].user.id, [[HISTORICAL_START, new Date("2026-09-16T11:00:00Z"), 1000]]);
    const modifiers = await computeEffectModifiers(
      [quicksand], 1000, data.accounts[1].user.id, StepSample, true, null,
      new Date("2026-09-16T11:00:00Z"),
    );
    const copied = await computeHitchhikeCopiedSteps(
      hitchhike, StepSample, new Date("2026-09-16T23:02:00Z"), {
        targetParticipantId: target.id,
        raceId: data.race.id,
        raceActiveEffectModel: RaceActiveEffect,
      },
    );
    assert.equal(modifiers.frozenSteps, 1000);
    assert.equal(copied, 0, "Hitchhike observes post-effect target steps");
  });

  it("keeps Quicksand + Leech freeze precedence deterministic", async () => {
    const data = await historicalFixture({ users: 2 });
    const quicksand = await historicalEffect(data, 1, "QUICKSAND", HISTORICAL_START, new Date("2026-09-16T11:00:00Z"), { stepsAtFreezeStart: 0 });
    const leech = await historicalEffect(data, 1, "LEECH", HISTORICAL_START, new Date("2026-09-16T11:00:00Z"), { ratio: 2 }, 0);
    await historicalSamples(data.accounts[1].user.id, [[HISTORICAL_START, new Date("2026-09-16T11:00:00Z"), 1000]]);
    const modifiers = await computeEffectModifiers(
      [quicksand, leech], 1000, data.accounts[1].user.id, StepSample, true, null,
      new Date("2026-09-16T11:00:00Z"),
    );
    assert.equal(modifiers.frozenSteps, 1000);
    assert.equal(modifiers.leechTransfers.length, 1);
    assert.equal(modifiers.leechTransfers[0].earnedTransfer, 0, "a frozen target has no eligible steps to leech");
  });

  it("keeps completed-race Quicksand history deterministic after late samples", async () => {
    const data = await historicalFixture({ status: "COMPLETED" });
    const effect = await historicalEffect(data, 0, "QUICKSAND", HISTORICAL_START, new Date("2026-09-16T11:00:00Z"), { stepsAtFreezeStart: 0 });
    await historicalSamples(data.accounts[0].user.id, [[HISTORICAL_START, new Date("2026-09-16T11:00:00Z"), 900]]);
    await queueHistorical(data);
    await reconcileHistorical();
    const first = await prisma.historicalEffectContribution.findFirstOrThrow({ where: { effectId: effect.id } });
    assert.equal(first.currentDeltaSteps, -900);
    await prisma.stepSample.updateMany({ where: { userId: data.accounts[0].user.id }, data: { steps: 1200 } });
    await prisma.userScoringInputVersion.update({ where: { userId: data.accounts[0].user.id }, data: { generation: 3 } });
    await queueHistorical(data, HISTORICAL_START, HISTORICAL_END, 3);
    await reconcileHistorical();
    const final = await prisma.historicalEffectContribution.findFirstOrThrow({ where: { effectId: effect.id } });
    assert.equal(final.currentDeltaSteps, -1200);
  });

  it("keeps Quicksand visible to free users but only eligible for Gold Daily Spin selection", async () => {
    await seedQuicksandCatalog();
    const free = await createTestUser();
    const gold = await createTestUser();
    await makeGold(gold.user.id);
    const headers = { "X-Client-Features": "spinPowerups,powerups4" };
    const path = `/daily-reward/status?localDate=2026-09-16`;
    const freeStatus = await request(server.baseUrl, "GET", path, { token: free.token, headers });
    const goldStatus = await request(server.baseUrl, "GET", path, { token: gold.token, headers });
    const freeBody = await freeStatus.json();
    const goldBody = await goldStatus.json();
    assert.equal(freeStatus.status, 200);
    assert.equal(goldStatus.status, 200);
    assert.ok(freeBody.box.powerupPool.some((item) => item.powerupType === "QUICKSAND"));
    assert.ok(!freeBody.box.eligiblePowerupTypes.includes("QUICKSAND"));
    assert.ok(goldBody.box.eligiblePowerupTypes.includes("QUICKSAND"));
  });

  it("keeps Quicksand out of in-race mystery-box drops while retaining its shop row", async () => {
    await seedQuicksandCatalog();
    const row = await prisma.powerupShopItem.findUniqueOrThrow({ where: { sku: "POWERUP_QUICKSAND" } });
    assert.equal(row.active, true);
    assert.equal(row.dailyRewardEligible, true);
    const { balanceConfig } = require("../../src/modules/economy/balanceConfig");
    const config = await balanceConfig.getConfig();
    assert.ok(!Object.values(config.dropPool).some((pool) => pool.includes("QUICKSAND")));
  });

  it("allows a non-Gold user to use already-owned Quicksand", async () => {
    const users = await Promise.all([createTestUser(), createTestUser()]);
    const raceId = await activeRace(users);
    const item = await held(raceId, users[0].user.id);
    const response = await request(server.baseUrl, "POST", `/races/${raceId}/powerups/${item.id}/use`, {
      token: users[0].token,
      headers: P4,
      body: { targetUserIds: [users[1].user.id] },
    });
    assert.equal(response.status, 200, JSON.stringify(await response.json()));
    assert.equal((await prisma.racePowerup.findUniqueOrThrow({ where: { id: item.id } })).status, "USED");
  });
});
