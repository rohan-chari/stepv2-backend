const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const { RacePowerupEvent } = require("../../../src/modules/powerups/models/racePowerupEvent");

describe("RacePowerupEvent transaction client", () => {
  it("creates through the supplied transaction client", async () => {
    const calls = [];
    const tx = {
      racePowerupEvent: {
        async create(args) {
          calls.push(args);
          return {
            id: "event-1",
            raceId: "race-1",
            createdAt: new Date("2026-09-17T12:00:00.000Z"),
          };
        },
      },
    };

    const row = await RacePowerupEvent.create({
      prisma: tx,
      raceId: "race-1",
      actorUserId: "user-1",
      eventType: "POWERUP_USED",
      powerupType: "LEG_CRAMP",
      description: "A power-up was used.",
    });

    assert.equal(row.id, "event-1");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].data.raceId, "race-1");
  });
});
