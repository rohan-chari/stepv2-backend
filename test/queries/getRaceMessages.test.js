const assert = require("node:assert/strict");
const test = require("node:test");

const { buildGetRaceMessages } = require("../../src/modules/social/queries/getRaceMessages");

function race(overrides = {}) {
  return {
    id: "race-1",
    powerupsEnabled: false,
    participants: [{ userId: "user-1", status: "ACCEPTED" }],
    ...overrides,
  };
}

test("getRaceMessages cursor keeps same-timestamp messages on the next page", async () => {
  const createdAt = new Date("2026-05-18T20:00:00.000Z");
  const getRaceMessages = buildGetRaceMessages({
    Race: {
      async findById() {
        return race();
      },
    },
    RaceMessage: {
      async findByRace(_raceId, { cursor }) {
        const rows = [
          {
            id: "msg-c",
            raceId: "race-1",
            senderId: "user-2",
            body: "third",
            createdAt,
            sender: { displayName: "C", profilePhotoUrl: null },
          },
          {
            id: "msg-b",
            raceId: "race-1",
            senderId: "user-2",
            body: "second",
            createdAt,
            sender: { displayName: "B", profilePhotoUrl: null },
          },
          {
            id: "msg-a",
            raceId: "race-1",
            senderId: "user-2",
            body: "first",
            createdAt,
            sender: { displayName: "A", profilePhotoUrl: null },
          },
        ];
        if (!cursor) return rows.slice(0, 2);
        return rows.filter((row) => row.id < cursor.id);
      },
    },
    RacePowerupEvent: {
      async findByRace() {
        return [];
      },
    },
    RaceActiveEffect: {
      async findActiveForRace() {
        return [];
      },
    },
  });

  const firstPage = await getRaceMessages("user-1", "race-1", { limit: 1 });
  assert.deepEqual(
    firstPage.messages.map((message) => message.id),
    ["msg-c"]
  );
  assert.ok(firstPage.nextCursor);

  const secondPage = await getRaceMessages("user-1", "race-1", {
    cursor: firstPage.nextCursor,
    limit: 2,
  });
  assert.deepEqual(
    secondPage.messages.map((message) => message.id),
    ["msg-b", "msg-a"]
  );
});
