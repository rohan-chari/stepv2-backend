// Randomness is the one mystery-box property a black-box request cannot pin.
// This suite injects only the command's RNG seam into the real Express router;
// every assertion still crosses public HTTP and uses disposable Postgres for
// participants, inventory, events, repair, and response serialization.
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { describe, it, before, after, beforeEach } = require("node:test");

const {
  cleanDatabase,
  prisma,
  request,
  startServer,
  createTestUser,
} = require("./setup");
const {
  buildOpenMysteryBox,
} = require("../../src/modules/powerups/commands/openMysteryBox");
const {
  buildOpenMysteryBoxBatch,
} = require("../../src/modules/powerups/commands/openMysteryBoxBatch");
const {
  repairRacePowerupInventory,
} = require("../../src/modules/races/services/racePowerupInventoryRepair");

const FEATURES = {
  "X-Client-Features": "powerups2,powerups3,powerups4,powerups5",
};

describe("deterministic mystery-box public path", () => {
  let server;
  let rolls;

  before(async () => {
    const outcomes = [
      { type: "FANNY_PACK", rarity: "RARE" },
      { type: "FANNY_PACK", rarity: "RARE" },
      { type: "PROTEIN_SHAKE", rarity: "COMMON" },
    ];
    rolls = [];
    const openMysteryBox = buildOpenMysteryBox({
      rollPowerupOdds(position, totalParticipants) {
        rolls.push({ position, totalParticipants });
        return outcomes.shift();
      },
      balanceConfig: {
        async getSnapshot() {
          return {
            version: 1,
            config: {
              rarityByType: {
                FANNY_PACK: "RARE",
                PROTEIN_SHAKE: "COMMON",
              },
            },
          };
        },
      },
      repairRacePowerupInventory,
    });
    server = await startServer({
      verifyAppleIdentityToken: async (token) => ({ sub: token }),
      openMysteryBox,
      openMysteryBoxBatch: buildOpenMysteryBoxBatch({ openMysteryBox }),
    });
  });

  after(async () => {
    await server.close();
  });

  beforeEach(cleanDatabase);

  it("refreshes joined/live context for every batch roll and handles two consecutive Fanny rolls", async () => {
    const { user, token } = await createTestUser({ displayName: "TwoFanny" });
    const race = await prisma.race.create({
      data: {
        creatorId: user.id,
        name: `Two Fanny ${randomUUID()}`,
        targetSteps: 100000,
        status: "ACTIVE",
        startedAt: new Date(Date.now() - 60_000),
        endsAt: new Date(Date.now() + 86_400_000),
        timezone: "UTC",
        powerupsEnabled: true,
        powerupStepInterval: 1000,
      },
    });
    const participant = await prisma.raceParticipant.create({
      data: {
        raceId: race.id,
        userId: user.id,
        status: "ACCEPTED",
        powerupSlots: 3,
      },
    });
    await prisma.racePowerup.create({
      data: {
        raceId: race.id,
        participantId: participant.id,
        userId: user.id,
        type: "PROTEIN_SHAKE",
        rarity: "COMMON",
        status: "HELD",
        earnedAtSteps: 900,
      },
    });
    const boxes = await Promise.all([1000, 2000].map((earnedAtSteps) =>
      prisma.racePowerup.create({
        data: {
          raceId: race.id,
          participantId: participant.id,
          userId: user.id,
          status: "MYSTERY_BOX",
          earnedAtSteps,
        },
      })
    ));

    const response = await request(
      server.baseUrl,
      "POST",
      `/races/${race.id}/powerups/open-batch`,
      {
        token,
        headers: FEATURES,
        body: { powerupIds: boxes.map((box) => box.id), maxCount: 20 },
      }
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.results.map(({ type, autoActivated }) => ({ type, autoActivated })), [
      { type: "FANNY_PACK", autoActivated: true },
      { type: "PROTEIN_SHAKE", autoActivated: false },
    ]);
    assert.equal(body.powerupSlots, 4);
    assert.equal(rolls.length, 3, "the second Fanny is re-rolled against fresh four-slot state");
    assert.deepEqual(rolls, [
      { position: 1, totalParticipants: 1 },
      { position: 1, totalParticipants: 1 },
      { position: 1, totalParticipants: 1 },
    ]);
    assert.equal(
      await prisma.racePowerupEvent.count({
        where: { raceId: race.id, eventType: "MYSTERY_BOX_OPENED" },
      }),
      2
    );
  });
});
