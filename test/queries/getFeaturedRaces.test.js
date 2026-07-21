const assert = require("node:assert/strict");
const test = require("node:test");

const { buildGetFeaturedRaces } = require("../../src/modules/races/queries/getFeaturedRaces");

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
  // Pool + paid-place projection scales with the current field. Daily has 2
  // ACCEPTED (pool floors at 100, places cap to the field = 2); weekly has 1
  // (pool floors at 500, places cap to the field = 1).
  assert.deepEqual(result[0].finishReward, { pool: 100, paidPlaces: 2 });
  assert.deepEqual(result[1].finishReward, { pool: 500, paidPlaces: 1 });
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

// --- pre-registration (upcoming) ---

function makePending(overrides) {
  return makeRace({
    id: "pending-daily",
    status: "PENDING",
    startedAt: null,
    scheduledStartAt: new Date("2026-05-30T04:00:00Z"),
    endsAt: new Date("2026-05-31T04:00:00Z"),
    participants: [],
    ...overrides,
  });
}

test("getFeaturedRaces never emits a PENDING seeded race as its own card (old-client safety)", async () => {
  const active = makeRace({ id: "active-daily" });
  const pending = makePending();
  // Even if the PENDING race has a later startedAt-equivalent, it must not shadow
  // or join the array.
  const getFeaturedRaces = buildGetFeaturedRaces(makeDeps([pending, active]));

  const result = await getFeaturedRaces({ userId: "viewer" });

  assert.equal(result.length, 1);
  assert.equal(result[0].raceId, "active-daily");
  assert.equal(result[0].status, undefined); // no status field leaks the pending one
});

test("getFeaturedRaces surfaces the PENDING race via the additive `upcoming` field", async () => {
  const active = makeRace({ id: "active-daily" });
  const pending = makePending({
    participants: [
      { userId: "viewer", status: "ACCEPTED" },
      { userId: "x", status: "ACCEPTED" },
    ],
  });
  const getFeaturedRaces = buildGetFeaturedRaces(makeDeps([active, pending]));

  const [card] = await getFeaturedRaces({ userId: "viewer" });

  assert.ok(card.upcoming, "expected an upcoming object");
  assert.equal(card.upcoming.raceId, "pending-daily");
  assert.equal(card.upcoming.participantCount, 2);
  assert.equal(card.upcoming.myStatus, "ACCEPTED"); // viewer opted in -> "You're in"
  assert.deepEqual(
    new Date(card.upcoming.scheduledStartAt),
    new Date("2026-05-30T04:00:00Z")
  );
});

test("getFeaturedRaces upcoming is null when no PENDING race exists for the seed", async () => {
  const getFeaturedRaces = buildGetFeaturedRaces(makeDeps([makeRace({})]));
  const [card] = await getFeaturedRaces({ userId: "viewer" });
  assert.equal(card.upcoming, null);
});

test("getFeaturedRaces upcoming.myStatus is null when the viewer has not opted in", async () => {
  const active = makeRace({ id: "active-daily" });
  const pending = makePending({
    participants: [{ userId: "someone-else", status: "ACCEPTED" }],
  });
  const getFeaturedRaces = buildGetFeaturedRaces(makeDeps([active, pending]));
  const [card] = await getFeaturedRaces({ userId: "viewer" });
  assert.equal(card.upcoming.myStatus, null); // -> render "Opt in"
});

test("getFeaturedRaces treats null maxParticipants as unlimited (isFull false)", async () => {
  const race = makeRace({
    maxParticipants: null,
    participants: [
      { userId: "a", status: "ACCEPTED" },
      { userId: "b", status: "ACCEPTED" },
    ],
  });
  const getFeaturedRaces = buildGetFeaturedRaces(makeDeps([race]));

  const [card] = await getFeaturedRaces({ userId: "viewer" });

  assert.equal(card.isFull, false);
  assert.equal(card.maxParticipants, 100); // legacy int surface for old clients
});
