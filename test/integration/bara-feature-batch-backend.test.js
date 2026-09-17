const assert = require("node:assert/strict");
const { before, beforeEach, describe, it } = require("node:test");

const {
  cleanDatabase,
  createTestUser,
  getSharedServer,
  prisma,
  request,
} = require("./setup");
const { RacePowerupEvent } = require("../../src/modules/powerups/models/racePowerupEvent");

let server;

async function createRaceWithParticipant(user, status) {
  const now = new Date("2026-09-17T12:00:00.000Z");
  const race = await prisma.race.create({
    data: {
      creatorId: user.id,
      name: `Terminal ${status}`,
      targetSteps: 100000,
      status,
      startedAt: status === "ACTIVE" ? now : null,
      endsAt: status === "ACTIVE" ? new Date(now.getTime() + 86400000) : null,
      completedAt: status === "COMPLETED" ? now : null,
      powerupsEnabled: true,
    },
  });
  const participant = await prisma.raceParticipant.create({
    data: {
      raceId: race.id,
      userId: user.id,
      status: "ACCEPTED",
      favoritedAt: new Date("2026-09-17T11:00:00.000Z"),
    },
  });
  return { race, participant };
}

async function createActiveDecoyRace(attacker, owner, landing) {
  const now = new Date("2026-09-17T12:00:00.000Z");
  const race = await prisma.race.create({
    data: {
      creatorId: attacker.id,
      name: "Decoy metadata race",
      targetSteps: 100000,
      status: "ACTIVE",
      startedAt: now,
      endsAt: new Date(now.getTime() + 86400000),
      powerupsEnabled: true,
      powerupStepInterval: 5000,
    },
  });
  const participants = await Promise.all(
    [attacker, owner, landing].map((user) => prisma.raceParticipant.create({
      data: { raceId: race.id, userId: user.id, status: "ACCEPTED" },
    })),
  );
  const byUserId = new Map(participants.map((participant) => [participant.userId, participant]));
  const decoy = await prisma.racePowerup.create({
    data: {
      raceId: race.id,
      participantId: byUserId.get(owner.id).id,
      userId: owner.id,
      type: "DECOY",
      rarity: "RARE",
      status: "USED",
      usedAt: now,
    },
  });
  await prisma.raceActiveEffect.create({
    data: {
      raceId: race.id,
      targetParticipantId: byUserId.get(owner.id).id,
      targetUserId: owner.id,
      sourceUserId: owner.id,
      powerupId: decoy.id,
      type: "DECOY",
      status: "ACTIVE",
      startsAt: now,
      expiresAt: new Date(now.getTime() + 86400000),
    },
  });
  const attack = await prisma.racePowerup.create({
    data: {
      raceId: race.id,
      participantId: byUserId.get(attacker.id).id,
      userId: attacker.id,
      type: "LEG_CRAMP",
      rarity: "COMMON",
      status: "HELD",
      earnedAtSteps: 1000,
    },
  });
  return { race, attack };
}

describe("Bara feature batch backend contracts", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(cleanDatabase);

  it("uses the supplied transaction client and rolls back event persistence", async () => {
    const user = await createTestUser({ displayName: "Transaction actor" });
    const { race } = await createRaceWithParticipant(user.user, "ACTIVE");

    await prisma.$transaction(async (tx) => {
      await RacePowerupEvent.create({
        prisma: tx,
        raceId: race.id,
        actorUserId: user.user.id,
        eventType: "POWERUP_USED",
        powerupType: "LEG_CRAMP",
        description: "Committed activity",
      });
    });
    assert.equal(
      await prisma.racePowerupEvent.count({ where: { raceId: race.id } }),
      1,
    );

    await assert.rejects(
      prisma.$transaction(async (tx) => {
        await RacePowerupEvent.create({
          prisma: tx,
          raceId: race.id,
          actorUserId: user.user.id,
          eventType: "POWERUP_USED",
          powerupType: "LEG_CRAMP",
          description: "Rolled-back activity",
        });
        throw new Error("rollback test");
      }),
      /rollback test/,
    );
    assert.equal(
      await prisma.racePowerupEvent.count({ where: { raceId: race.id } }),
      1,
    );
  });

  it("preserves POWERUP_REDIRECTED and exposes additive structured Decoy metadata", async () => {
    const attacker = await createTestUser({ displayName: "Original Attacker" });
    const owner = await createTestUser({ displayName: "Decoy Owner" });
    const landing = await createTestUser({ displayName: "Final Landing" });
    const { race, attack } = await createActiveDecoyRace(attacker.user, owner.user, landing.user);

    const response = await request(
      server.baseUrl,
      "POST",
      `/races/${race.id}/powerups/${attack.id}/use`,
      {
        token: attacker.token,
        headers: { "X-Client-Features": "powerups5" },
        body: { targetUserId: owner.user.id },
      },
    );
    assert.equal(response.status, 200, await response.text());

    const event = await prisma.racePowerupEvent.findFirst({
      where: { raceId: race.id, eventType: "POWERUP_REDIRECTED" },
    });
    assert.ok(event);
    // Preserve legacy attribution for frozen clients; activityV1 carries the
    // original attacker explicitly.
    assert.equal(event.actorUserId, owner.user.id);
    assert.equal(event.targetUserId, landing.user.id);
    assert.deepEqual(event.metadata.attackerUserId, attacker.user.id);
    assert.deepEqual(event.metadata.decoyOwnerUserId, owner.user.id);
    assert.deepEqual(event.metadata.redirectedUserId, landing.user.id);
    assert.deepEqual(event.metadata.activityV1, {
      action: "POWERUP_USE",
      version: 1,
      originalAttackerUserId: attacker.user.id,
      originalTargetUserId: owner.user.id,
      finalTargetUserId: landing.user.id,
      redirect: {
        type: "DECOY",
        ownerUserId: owner.user.id,
        recipientUserId: landing.user.id,
      },
      outcome: "REDIRECTED",
    });

    const feed = await request(server.baseUrl, "GET", `/races/${race.id}/feed`, {
      token: attacker.token,
      headers: { "X-Client-Features": "powerups5" },
    });
    assert.equal(feed.status, 200);
    const projected = (await feed.json()).events.find(
      (row) => row.eventType === "POWERUP_REDIRECTED",
    );
    assert.deepEqual(projected.metadata.activityV1, event.metadata.activityV1);
  });

  it("does not pin completed or cancelled races while retaining favoritedAt", async () => {
    const user = await createTestUser({ displayName: "Pinned terminal viewer" });
    const active = await createRaceWithParticipant(user.user, "ACTIVE");
    const completed = await createRaceWithParticipant(user.user, "COMPLETED");
    const cancelled = await createRaceWithParticipant(user.user, "CANCELLED");

    const response = await request(server.baseUrl, "GET", "/races", {
      token: user.token,
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    const find = (id) => [...body.active, ...body.pending, ...body.completed]
      .find((row) => row.id === id);
    assert.ok(find(active.race.id), JSON.stringify(body));
    assert.ok(find(completed.race.id), JSON.stringify(body));
    // GET /races has no cancelled bucket; terminal cancellation is omitted
    // from the presentation while the participant favorite remains durable.
    assert.equal(find(cancelled.race.id), undefined);
    assert.equal(find(active.race.id).isFavorite, true);
    // `isFavorite` remains the durable legacy field; pinned presentation
    // filtering must not repurpose it for terminal-state eligibility.
    assert.equal(find(completed.race.id).isFavorite, true);
    assert.ok(find(completed.race.id).favoritedAt);

    const stored = await prisma.raceParticipant.findMany({
      where: { raceId: { in: [completed.race.id, cancelled.race.id] }, userId: user.user.id },
      select: { favoritedAt: true },
    });
    assert.equal(stored.length, 2);
    assert.ok(stored.every((row) => row.favoritedAt instanceof Date));
  });
});
