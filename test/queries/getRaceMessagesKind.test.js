const assert = require("node:assert/strict");
const test = require("node:test");

const { buildGetRaceMessages } = require("../../src/modules/social/queries/getRaceMessages");

const T = "2026-05-18T20:00:00.000Z";

function race(overrides = {}) {
  return {
    id: "race-1",
    powerupsEnabled: true,
    participants: [
      { userId: "user-1", status: "ACCEPTED" },
      {
        userId: "actor-stealth",
        status: "ACCEPTED",
        user: { displayName: "Sneaky" },
      },
    ],
    ...overrides,
  };
}

const userRows = [
  {
    id: "msg-b",
    raceId: "race-1",
    senderId: "user-2",
    body: "hello",
    createdAt: new Date("2026-05-18T20:00:02.000Z"),
    sender: { displayName: "B", profilePhotoUrl: "http://photo/b.png" },
  },
  {
    id: "msg-a",
    raceId: "race-1",
    senderId: "user-2",
    body: "hi",
    createdAt: new Date("2026-05-18T20:00:00.000Z"),
    sender: { displayName: "A", profilePhotoUrl: "http://photo/a.png" },
  },
];

const eventRows = [
  {
    id: "evt-2",
    eventType: "POWERUP_USED",
    powerupType: "LEG_CRAMP",
    description: "Sneaky used Leg Cramp on B",
    actorUserId: "actor-stealth",
    targetUserId: "user-2",
    createdAt: new Date("2026-05-18T20:00:01.000Z"),
  },
  {
    id: "evt-1",
    eventType: "POWERUP_RECEIVED",
    powerupType: "TRAIL_MIX",
    description: "B received Trail Mix",
    actorUserId: "user-2",
    targetUserId: null,
    createdAt: new Date("2026-05-18T19:59:59.000Z"),
  },
];

function buildQuery({ stealth = [] } = {}) {
  let userCalls = 0;
  let eventCalls = 0;
  const fn = buildGetRaceMessages({
    Race: {
      async findById() {
        return race();
      },
    },
    RaceMessage: {
      async findByRace() {
        userCalls += 1;
        return userRows;
      },
    },
    RacePowerupEvent: {
      async findByRace() {
        eventCalls += 1;
        return eventRows;
      },
    },
    RaceActiveEffect: {
      async findActiveForRace() {
        return stealth;
      },
    },
  });
  return {
    fn,
    counts: () => ({ userCalls, eventCalls }),
  };
}

test("kind=USER returns user messages only and never queries events", async () => {
  const { fn, counts } = buildQuery();
  const res = await fn("user-1", "race-1", { kind: "USER", limit: 50 });
  assert.ok(res.messages.length > 0);
  assert.ok(res.messages.every((m) => m.kind === "USER"));
  assert.deepEqual(
    res.messages.map((m) => m.id),
    ["msg-b", "msg-a"]
  );
  // SYSTEM source should be skipped entirely.
  assert.equal(counts().eventCalls, 0);
  assert.equal(counts().userCalls, 1);
});

test("kind=SYSTEM returns system events only and never queries user messages", async () => {
  const { fn, counts } = buildQuery();
  const res = await fn("user-1", "race-1", { kind: "SYSTEM", limit: 50 });
  assert.ok(res.messages.length > 0);
  assert.ok(res.messages.every((m) => m.kind === "SYSTEM"));
  assert.deepEqual(
    res.messages.map((m) => m.id),
    ["evt_evt-2", "evt_evt-1"]
  );
  assert.equal(counts().userCalls, 0);
  assert.equal(counts().eventCalls, 1);
});

test("no kind param returns merged feed sorted newest-first (backward compatible)", async () => {
  const { fn, counts } = buildQuery();
  const res = await fn("user-1", "race-1", { limit: 50 });
  assert.deepEqual(
    res.messages.map((m) => m.id),
    ["msg-b", "evt_evt-2", "msg-a", "evt_evt-1"]
  );
  assert.ok(res.messages.some((m) => m.kind === "USER"));
  assert.ok(res.messages.some((m) => m.kind === "SYSTEM"));
  assert.equal(counts().userCalls, 1);
  assert.equal(counts().eventCalls, 1);
});

test("kind=SYSTEM applies stealth redaction to event descriptions", async () => {
  const { fn } = buildQuery({
    stealth: [{ type: "STEALTH_MODE", targetUserId: "actor-stealth" }],
  });
  const res = await fn("user-1", "race-1", { kind: "SYSTEM", limit: 50 });
  const cramp = res.messages.find((m) => m.id === "evt_evt-2");
  assert.ok(cramp);
  assert.ok(!cramp.body.includes("Sneaky"));
  assert.ok(cramp.body.includes("???"));
});

test("kind=USER never redacts senderName/photo even when a user is stealthed", async () => {
  const { fn } = buildQuery({
    stealth: [{ type: "STEALTH_MODE", targetUserId: "user-2" }],
  });
  const res = await fn("user-1", "race-1", { kind: "USER", limit: 50 });
  for (const m of res.messages) {
    assert.ok(m.senderName);
    assert.ok(m.senderPhotoUrl);
  }
});

test("kind=USER paginates with a working nextCursor", async () => {
  const { fn } = buildQuery();
  const first = await fn("user-1", "race-1", { kind: "USER", limit: 1 });
  assert.deepEqual(
    first.messages.map((m) => m.id),
    ["msg-b"]
  );
  assert.ok(first.nextCursor);
});

test("invalid kind value falls back to merged feed", async () => {
  const { fn } = buildQuery();
  const res = await fn("user-1", "race-1", { kind: "bogus", limit: 50 });
  assert.ok(res.messages.some((m) => m.kind === "USER"));
  assert.ok(res.messages.some((m) => m.kind === "SYSTEM"));
});
