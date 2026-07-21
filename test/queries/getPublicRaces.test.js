const assert = require("node:assert/strict");
const test = require("node:test");

const { buildGetPublicRaces } = require("../../src/modules/races/queries/getPublicRaces");

function makeDeps(races) {
  return {
    Race: {
      async findPublicPending() {
        return races;
      },
    },
  };
}

function makeRace(overrides) {
  return {
    id: "r1",
    name: "Public Race",
    targetSteps: 50000,
    status: "PENDING",
    isPublic: true,
    maxParticipants: 10,
    buyInAmount: 0,
    payoutPreset: "WINNER_TAKES_ALL",
    powerupsEnabled: false,
    powerupStepInterval: null,
    maxDurationDays: 7,
    creatorId: "creator-1",
    creator: { id: "creator-1", displayName: "Alice" },
    participants: [
      { userId: "creator-1", status: "ACCEPTED" },
    ],
    createdAt: new Date("2026-01-01"),
    ...overrides,
  };
}

test("getPublicRaces returns races with creator + participant count", async () => {
  const deps = makeDeps([makeRace({})]);
  const getPublicRaces = buildGetPublicRaces(deps);

  const result = await getPublicRaces({ userId: "viewer-1" });

  assert.equal(result.length, 1);
  assert.equal(result[0].id, "r1");
  assert.equal(result[0].creator.displayName, "Alice");
  assert.equal(result[0].participantCount, 1);
  assert.equal(result[0].maxParticipants, 10);
});

test("getPublicRaces excludes races the user is already in", async () => {
  const inRace = makeRace({
    id: "r-in",
    participants: [
      { userId: "creator-1", status: "ACCEPTED" },
      { userId: "viewer-1", status: "ACCEPTED" },
    ],
  });
  const otherRace = makeRace({ id: "r-other" });
  const deps = makeDeps([inRace, otherRace]);
  const getPublicRaces = buildGetPublicRaces(deps);

  const result = await getPublicRaces({ userId: "viewer-1" });

  assert.equal(result.length, 1);
  assert.equal(result[0].id, "r-other");
});

test("getPublicRaces excludes full races", async () => {
  const fullRace = makeRace({
    id: "r-full",
    maxParticipants: 2,
    participants: [
      { userId: "a", status: "ACCEPTED" },
      { userId: "b", status: "ACCEPTED" },
    ],
  });
  const deps = makeDeps([fullRace]);
  const getPublicRaces = buildGetPublicRaces(deps);

  const result = await getPublicRaces({ userId: "viewer-1" });
  assert.equal(result.length, 0);
});

test("getPublicRaces counts only ACCEPTED participants", async () => {
  const race = makeRace({
    participants: [
      { userId: "creator-1", status: "ACCEPTED" },
      { userId: "u2", status: "INVITED" },
      { userId: "u3", status: "DECLINED" },
    ],
  });
  const deps = makeDeps([race]);
  const getPublicRaces = buildGetPublicRaces(deps);

  const result = await getPublicRaces({ userId: "viewer-1" });
  assert.equal(result[0].participantCount, 1);
});
