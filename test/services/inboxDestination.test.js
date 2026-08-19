const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { createInboxAlert } = require("../../src/modules/inbox/services/inbox");

function createTransactionRecorder() {
  let alertCreate;
  let deliveryCreate;
  const tx = {
    inboxAlert: {
      upsert: async ({ create }) => {
        alertCreate = create;
        return { id: "alert-1", ...create };
      },
    },
    inboxDeliveryOutbox: {
      upsert: async ({ create }) => {
        deliveryCreate = create;
        return create;
      },
    },
  };
  return {
    tx,
    writes: () => ({ alertCreate, deliveryCreate }),
  };
}

async function createWithDestination(destination, tx) {
  return createInboxAlert({
    userId: "user-1",
    type: "SYSTEM",
    title: "Destination test",
    body: "Open the requested Inbox destination.",
    destination,
    sourceKey: `destination:${JSON.stringify(destination)}`,
    now: new Date("2026-08-18T12:00:00.000Z"),
    tx,
  });
}

describe("Inbox shell destination creation", () => {
  const allowed = [
    { route: "home" },
    { route: "dailyReward" },
    { route: "friends" },
    { route: "races" },
    { route: "inbox" },
    { route: "profile" },
    { route: "raceDetail", raceId: "race-1" },
    { route: "tournamentDetail", tournamentId: "tournament-1" },
    { route: "supportThread", threadId: "thread-1" },
  ];

  for (const destination of allowed) {
    it(`creates an alert and delivery intent for ${destination.route}`, async () => {
      const recorder = createTransactionRecorder();
      const alert = await createWithDestination(destination, recorder.tx);
      const { alertCreate, deliveryCreate } = recorder.writes();

      assert.deepEqual(alert.destination, destination);
      assert.deepEqual(alertCreate.destination, destination);
      assert.deepEqual(deliveryCreate.payload.destination, destination);
    });
  }

  const rejected = [
    ["unknown route", { route: "settings" }],
    ["extra key", { route: "home", unexpected: "value" }],
    ["missing race id", { route: "raceDetail" }],
    ["missing tournament id", { route: "tournamentDetail" }],
    ["missing thread id", { route: "supportThread" }],
    ["empty race id", { route: "raceDetail", raceId: "" }],
    ["empty tournament id", { route: "tournamentDetail", tournamentId: "" }],
    ["empty thread id", { route: "supportThread", threadId: "" }],
    ["numeric route", { route: 42 }],
    ["numeric race id", { route: "raceDetail", raceId: 42 }],
    ["numeric tournament id", { route: "tournamentDetail", tournamentId: 42 }],
    ["numeric thread id", { route: "supportThread", threadId: 42 }],
    ["array destination", [{ route: "home" }]],
    ["missing destination", undefined],
    ["race id on home", { route: "home", raceId: "race-1" }],
    [
      "tournament id on race detail",
      { route: "raceDetail", raceId: "race-1", tournamentId: "tournament-1" },
    ],
    [
      "thread id on tournament detail",
      { route: "tournamentDetail", tournamentId: "tournament-1", threadId: "thread-1" },
    ],
    [
      "race id on support thread",
      { route: "supportThread", threadId: "thread-1", raceId: "race-1" },
    ],
  ];

  for (const [name, destination] of rejected) {
    it(`rejects ${name} before either durable write`, async () => {
      const recorder = createTransactionRecorder();
      await assert.rejects(
        createWithDestination(destination, recorder.tx),
        { name: "TypeError", message: /^Inbox / }
      );
      assert.deepEqual(recorder.writes(), {
        alertCreate: undefined,
        deliveryCreate: undefined,
      });
    });
  }
});
