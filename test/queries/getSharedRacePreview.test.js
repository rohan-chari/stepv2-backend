const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildGetSharedRacePreview,
} = require("../../src/queries/getSharedRacePreview");

function makeRace(overrides = {}) {
  return {
    id: "race-1",
    name: "Weekend Warriors",
    status: "PENDING",
    isPublic: false,
    powerupsEnabled: true,
    buyInAmount: 0,
    maxParticipants: 10,
    creator: { id: "creator-1", displayName: "Rohan", profilePhotoUrl: "http://img/p.png" },
    participants: [
      { userId: "creator-1", status: "ACCEPTED" },
      { userId: "u2", status: "ACCEPTED" },
      { userId: "u3", status: "INVITED" },
    ],
    ...overrides,
  };
}

function makeDeps(raceByToken) {
  return {
    Race: {
      async findByShareToken(token) {
        return raceByToken && raceByToken.shareToken === token
          ? raceByToken
          : raceByToken && raceByToken.__any
            ? raceByToken
            : null;
      },
    },
  };
}

test("getSharedRacePreview returns a sanitized preview for a known token", async () => {
  const race = makeRace({ __any: true });
  const getPreview = buildGetSharedRacePreview(makeDeps(race));

  const preview = await getPreview({ token: "tok-abc" });

  assert.equal(preview.id, "race-1");
  assert.equal(preview.name, "Weekend Warriors");
  assert.equal(preview.status, "PENDING");
  assert.equal(preview.powerupsEnabled, true);
  assert.equal(preview.maxParticipants, 10);
  // Only ACCEPTED participants count toward the displayed player count.
  assert.equal(preview.participantCount, 2);
  assert.deepEqual(preview.host, {
    displayName: "Rohan",
    profilePhotoUrl: "http://img/p.png",
  });
  assert.equal(preview.isJoinable, true);
});

test("getSharedRacePreview does NOT leak internal fields (creatorId, shareToken, raw participants)", async () => {
  const race = makeRace({ __any: true });
  const getPreview = buildGetSharedRacePreview(makeDeps(race));

  const preview = await getPreview({ token: "tok-abc" });

  assert.equal(preview.creatorId, undefined);
  assert.equal(preview.shareToken, undefined);
  assert.equal(preview.participants, undefined);
});

test("getSharedRacePreview returns null for an unknown token", async () => {
  const getPreview = buildGetSharedRacePreview(makeDeps(null));
  const preview = await getPreview({ token: "missing" });
  assert.equal(preview, null);
});

test("getSharedRacePreview marks a COMPLETED race as not joinable", async () => {
  const race = makeRace({ __any: true, status: "COMPLETED" });
  const getPreview = buildGetSharedRacePreview(makeDeps(race));

  const preview = await getPreview({ token: "tok-abc" });
  assert.equal(preview.isJoinable, false);
});

test("getSharedRacePreview marks a full race as not joinable", async () => {
  const race = makeRace({
    __any: true,
    maxParticipants: 2,
    participants: [
      { userId: "creator-1", status: "ACCEPTED" },
      { userId: "u2", status: "ACCEPTED" },
    ],
  });
  const getPreview = buildGetSharedRacePreview(makeDeps(race));

  const preview = await getPreview({ token: "tok-abc" });
  assert.equal(preview.participantCount, 2);
  assert.equal(preview.isJoinable, false);
});

test("getSharedRacePreview treats null maxParticipants as unlimited (joinable)", async () => {
  const race = makeRace({ __any: true, maxParticipants: null });
  const getPreview = buildGetSharedRacePreview(makeDeps(race));

  const preview = await getPreview({ token: "tok-abc" });
  assert.equal(preview.isJoinable, true);
});

test("getSharedRacePreview tolerates a seeded race with no creator", async () => {
  const race = makeRace({ __any: true, creator: null });
  const getPreview = buildGetSharedRacePreview(makeDeps(race));

  const preview = await getPreview({ token: "tok-abc" });
  assert.equal(preview.host, null);
});
