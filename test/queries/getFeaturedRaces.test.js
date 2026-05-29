const assert = require("node:assert/strict");
const test = require("node:test");

const { buildGetFeaturedRaces } = require("../../src/queries/getFeaturedRaces");

const NOW = new Date("2026-05-29T12:00:00Z");

function makeDeps(races, now = () => NOW) {
  return {
    Race: {
      async findLiveSeeded() {
        return races;
      },
    },
    now,
  };
}

function makeRace(overrides) {
  return {
    id: "race-daily",
    seedId: "seed-daily-10k",
    seed: { kind: "DAILY_10K" },
    name: "Daily 10K Sprint",
    status: "ACTIVE",
    maxParticipants: 100,
    powerupsEnabled: true,
    startedAt: new Date("2026-05-29T00:00:00Z"),
    endsAt: new Date("2026-05-30T00:00:00Z"), // future relative to NOW
    participants: [],
    ...overrides,
  };
}

test("getFeaturedRaces returns both seeds ordered daily then weekly, with reward + counts", async () => {
  const daily = makeRace({
    id: "race-daily",
    participants: [
      { userId: "a", status: "ACCEPTED" },
      { userId: "b", status: "ACCEPTED" },
    ],
  });
  const weekly = makeRace({
    id: "race-weekly",
    seedId: "seed-weekly-50k",
    seed: { kind: "WEEKLY_50K" },
    name: "Weekly 50K Challenge",
    endsAt: new Date("2026-06-05T00:00:00Z"),
    participants: [{ userId: "a", status: "ACCEPTED" }],
  });
  // Pass weekly first to prove the daily->weekly sort.
  const getFeaturedRaces = buildGetFeaturedRaces(makeDeps([weekly, daily]));

  const result = await getFeaturedRaces({ userId: "viewer" });

  assert.equal(result.length, 2);
  assert.equal(result[0].seedKind, "DAILY_10K");
  assert.equal(result[1].seedKind, "WEEKLY_50K");
  assert.deepEqual(result[0].finishReward, { pool: 100, topFraction: 0.5 });
  assert.deepEqual(result[1].finishReward, { pool: 500, topFraction: 0.5 });
  assert.equal(result[0].participantCount, 2);
  assert.equal(result[0].raceId, "race-daily");
  assert.equal(result[0].myStatus, null);
});

test("getFeaturedRaces sets myStatus when the viewer already joined (so the card shows VIEW)", async () => {
  const daily = makeRace({
    participants: [{ userId: "viewer", status: "ACCEPTED" }],
  });
  const getFeaturedRaces = buildGetFeaturedRaces(makeDeps([daily]));

  const result = await getFeaturedRaces({ userId: "viewer" });

  assert.equal(result[0].myStatus, "ACCEPTED");
});

test("getFeaturedRaces excludes expired-but-still-active races", async () => {
  const expired = makeRace({ endsAt: new Date("2026-05-29T11:00:00Z") }); // before NOW
  const getFeaturedRaces = buildGetFeaturedRaces(makeDeps([expired]));

  const result = await getFeaturedRaces({ userId: "viewer" });

  assert.equal(result.length, 0);
});

test("getFeaturedRaces flags a full race but still pins it (unlike getPublicRaces)", async () => {
  const full = makeRace({
    maxParticipants: 2,
    participants: [
      { userId: "a", status: "ACCEPTED" },
      { userId: "b", status: "ACCEPTED" },
    ],
  });
  const getFeaturedRaces = buildGetFeaturedRaces(makeDeps([full]));

  const result = await getFeaturedRaces({ userId: "viewer" });

  assert.equal(result.length, 1);
  assert.equal(result[0].isFull, true);
});

test("getFeaturedRaces keeps the most recently started race per seed", async () => {
  const older = makeRace({
    id: "old",
    startedAt: new Date("2026-05-28T00:00:00Z"),
    endsAt: new Date("2026-05-30T00:00:00Z"),
  });
  const newer = makeRace({
    id: "new",
    startedAt: new Date("2026-05-29T06:00:00Z"),
    endsAt: new Date("2026-05-30T06:00:00Z"),
  });
  const getFeaturedRaces = buildGetFeaturedRaces(makeDeps([older, newer]));

  const result = await getFeaturedRaces({ userId: "viewer" });

  assert.equal(result.length, 1);
  assert.equal(result[0].raceId, "new");
});

test("getFeaturedRaces counts only ACCEPTED participants", async () => {
  const race = makeRace({
    participants: [
      { userId: "a", status: "ACCEPTED" },
      { userId: "b", status: "INVITED" },
      { userId: "c", status: "DECLINED" },
    ],
  });
  const getFeaturedRaces = buildGetFeaturedRaces(makeDeps([race]));

  const result = await getFeaturedRaces({ userId: "viewer" });

  assert.equal(result[0].participantCount, 1);
});
