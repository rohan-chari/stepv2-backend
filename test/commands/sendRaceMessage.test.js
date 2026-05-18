const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildSendRaceMessage,
  RaceMessageError,
} = require("../../src/commands/sendRaceMessage");

function makeRace(overrides = {}) {
  return {
    id: "race-1",
    name: "Evening Sprint",
    status: "ACTIVE",
    participants: [{ userId: "sender-1", status: "ACCEPTED" }],
    ...overrides,
  };
}

test("sendRaceMessage trims, censors, creates, and emits chat event", async () => {
  const events = [];
  const createdAt = new Date("2026-05-18T20:00:00.000Z");
  const sendRaceMessage = buildSendRaceMessage({
    Race: {
      async findById() {
        return makeRace();
      },
    },
    RaceMessage: {
      async countSentBySenderSince() {
        return 0;
      },
      async create(payload) {
        assert.deepEqual(payload, {
          raceId: "race-1",
          senderId: "sender-1",
          body: "clean text",
          kind: "USER",
        });
        return {
          id: "msg-1",
          ...payload,
          createdAt,
          sender: { displayName: "Trail Walker" },
        };
      },
    },
    censor() {
      return "clean text";
    },
    eventBus: {
      emit(event, payload) {
        events.push({ event, payload });
      },
    },
  });

  const message = await sendRaceMessage({
    userId: "sender-1",
    raceId: "race-1",
    body: "  bad text  ",
  });

  assert.equal(message.id, "msg-1");
  assert.deepEqual(events, [
    {
      event: "RACE_MESSAGE_SENT",
      payload: {
        raceId: "race-1",
        messageId: "msg-1",
        senderId: "sender-1",
        body: "clean text",
        senderName: "Trail Walker",
        raceName: "Evening Sprint",
      },
    },
  ]);
});

test("sendRaceMessage rejects non-accepted participants", async () => {
  const sendRaceMessage = buildSendRaceMessage({
    Race: {
      async findById() {
        return makeRace({
          participants: [{ userId: "sender-1", status: "PENDING" }],
        });
      },
    },
    RaceMessage: {
      async countSentBySenderSince() {
        return 0;
      },
      async create() {
        throw new Error("should not create");
      },
    },
  });

  await assert.rejects(
    () =>
      sendRaceMessage({
        userId: "sender-1",
        raceId: "race-1",
        body: "hello",
      }),
    (err) => {
      assert.ok(err instanceof RaceMessageError);
      assert.equal(err.statusCode, 403);
      return true;
    }
  );
});
