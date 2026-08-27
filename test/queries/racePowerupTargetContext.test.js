const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildGetRacePowerupTargetContext,
} = require("../../src/modules/races/queries/getRacePowerupTargetContext");

test("Bounty target context uses the narrow persisted roster instead of full progress", async () => {
  let progressLoads = 0;
  const getContext = buildGetRacePowerupTargetContext({
    Race: {
      async findPowerupTargetContext() {
        return {
          id: "race-1",
          status: "ACTIVE",
          powerupsEnabled: true,
          participants: [
            {
              id: "p-1", userId: "user-1", totalSteps: 100,
              finishedAt: null, placement: 1, forfeitedAt: null,
              team: null, joinedAt: new Date("2026-08-20T13:00:00Z"),
              powerupSlots: 3,
              user: { displayName: "Runner", profilePhotoUrl: null },
            },
          ],
        };
      },
    },
    RaceActiveEffect: { async findActiveForRace() { return []; } },
    RacePowerup: {
      async findInventoryForParticipants() {
        return [{ id: "powerup-1", type: "BOUNTY", rarity: "RARE", status: "HELD" }];
      },
    },
    now: () => new Date("2026-08-20T14:00:00Z"),
  });

  const result = await getContext({
    userId: "user-1",
    raceId: "race-1",
    powerupType: "BOUNTY",
    loadBountyProgress: async () => {
      progressLoads += 1;
      throw new Error("full progress should not load");
    },
  });

  assert.equal(progressLoads, 0);
  assert.equal(result.contract, "race-powerup-target-context-v1");
  assert.equal(result.participants[0].totalSteps, 100);
  assert.equal(result.powerupData.inventory[0].id, "powerup-1");
});

test("Detour keeps profiles masked while separately allowing offensive targeting", async () => {
  const getContext = buildGetRacePowerupTargetContext({
    Race: {
      async findPowerupTargetContext() {
        return {
          id: "race-1", status: "ACTIVE", powerupsEnabled: true,
          participants: [
            { id: "p-me", userId: "me", totalSteps: 10, finishedAt: null,
              placement: 2, forfeitedAt: null, team: null, powerupSlots: 3,
              user: { displayName: "Me", profilePhotoUrl: "me.png" } },
            { id: "p-rival", userId: "rival", totalSteps: 20, finishedAt: null,
              placement: 1, forfeitedAt: null, team: null,
              user: { displayName: "Rival", profilePhotoUrl: "rival.png" } },
          ],
        };
      },
    },
    RaceActiveEffect: {
      async findActiveForRace() {
        return [{ type: "DETOUR_SIGN", targetUserId: "me", expiresAt: new Date("2026-08-20T15:00:00Z") }];
      },
    },
    RacePowerup: { async findInventoryForParticipants() { return []; } },
    now: () => new Date("2026-08-20T14:00:00Z"),
  });

  const result = await getContext({ userId: "me", raceId: "race-1", powerupType: "DETOUR_SIGN" });
  const rival = result.participants.find((p) => p.userId === "rival");
  assert.equal(rival.displayName, "???");
  assert.equal(rival.profilePhotoUrl, null);
  assert.equal(Object.hasOwn(rival, "totalSteps"), false);
  assert.equal(rival.placement, null);
  assert.equal(rival.stealthed, true);
  assert.equal(rival.targetable, true);
});

test("target context still excludes a genuinely stealthed rival while the viewer is detoured", async () => {
  const getContext = buildGetRacePowerupTargetContext({
    Race: { async findPowerupTargetContext() {
      return {
        id: "race-1", status: "ACTIVE", powerupsEnabled: true,
        participants: [
          { id: "p-me", userId: "me", finishedAt: null, powerupSlots: 3,
            user: { displayName: "Me" } },
          { id: "p-rival", userId: "rival", finishedAt: null,
            user: { displayName: "Rival" } },
        ],
      };
    } },
    RaceActiveEffect: { async findActiveForRace() {
      return [
        { type: "DETOUR_SIGN", targetUserId: "me", expiresAt: new Date("2026-08-20T15:00:00Z") },
        { type: "STEALTH_MODE", targetUserId: "rival", expiresAt: new Date("2026-08-20T15:00:00Z") },
      ];
    } },
    RacePowerup: { async findInventoryForParticipants() { return []; } },
    now: () => new Date("2026-08-20T14:00:00Z"),
  });

  const result = await getContext({ userId: "me", raceId: "race-1", powerupType: "LEG_CRAMP" });
  const rival = result.participants.find((p) => p.userId === "rival");
  assert.equal(rival.displayName, "???");
  assert.equal(rival.stealthed, true);
  assert.equal(Object.hasOwn(rival, "targetable"), false);
});

test("target context returns participants in placement order", async () => {
  const getContext = buildGetRacePowerupTargetContext({
    Race: { async findPowerupTargetContext() {
      return { status: "ACTIVE", powerupsEnabled: true, participants: [
        { id: "p-2", userId: "u2", placement: 2, finishedAt: null, user: { displayName: "Two" } },
        { id: "p-1", userId: "u1", placement: 1, finishedAt: null, user: { displayName: "One" } },
      ] };
    } },
    RaceActiveEffect: { async findActiveForRace() { return []; } },
    RacePowerup: { async findInventoryForParticipants() { return []; } },
  });
  const result = await getContext({ userId: "u2", raceId: "r", powerupType: "DETOUR_SIGN" });
  assert.deepEqual(result.participants.map((p) => p.userId), ["u1", "u2"]);
});
