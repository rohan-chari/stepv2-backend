const assert = require("node:assert/strict");
const test = require("node:test");

const {
  PROJECTION_CONCURRENCY,
  buildNotificationProjector,
  buildTypedV1Projection,
} = require("../../src/modules/domainEvents/services/notificationProjector");

test("a projector tick never claims more rows than it finishes after its budget expires", async () => {
  const claimed = Array.from({ length: 50 }, (_, index) => ({
    id: `projection-${index}`,
    leaseToken: "lease-token",
  }));
  const finished = [];
  let claimCalls = 0;
  const monotonicTicks = [0, 0, 0, 2];
  const repository = {
    async loadProjectionContext(_prisma, id) {
      return {
        id,
        leaseToken: "lease-token",
        domainEventId: "event-1",
        recipientUserId: "user-1",
        projectionKind: "VISIBLE",
        attemptCount: 0,
        event: {
          id: "event-1",
          eventType: "FRIEND_REQUEST_SENT_V1",
          occurredAt: new Date(),
          availableAt: new Date(),
          payload: {},
          audience: [{ recipientId: "user-1", facts: {} }],
        },
      };
    },
    async loadRecipient() { return { id: "user-1" }; },
    async finishProjection(_prisma, input) { finished.push(input.id); return { count: 1 }; },
    async finishEventIfTerminal() { return false; },
  };
  const projector = buildNotificationProjector({
    prisma: {},
    repository,
    claimDomainEvents: async () => [],
    claimNotificationProjections: async ({ batchSize }) => {
      claimCalls += 1;
      assert.equal(batchSize, PROJECTION_CONCURRENCY);
      return claimCalls === 1 ? claimed.slice(0, batchSize) : [];
    },
    typedProjection: async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { status: "COMPLETED" };
    },
    silentRefreshDelivery: async () => {},
    monotonicNow: () => monotonicTicks.shift() ?? 2,
    logger: { log() {}, error() {} },
  });

  await projector.run({ budgetMs: 1 });
  assert.equal(claimCalls, 1, "the tick stops before claiming another lease batch");
  assert.deepEqual(finished.sort(), claimed.slice(0, PROJECTION_CONCURRENCY).map((row) => row.id).sort());
});

test("typed V1 handlers propagate infrastructure failures instead of suppressing them", async () => {
  const project = buildTypedV1Projection({
    prisma: {},
    User: {
      async findById() { throw Object.assign(new Error("user store unavailable"), { code: "DB_DOWN" }); },
    },
    notificationIntentService: { async submit() { throw new Error("must not submit"); } },
    logger: { log() {}, warn() {}, error() {} },
  });
  await assert.rejects(
    project({
      event: {
        eventType: "FRIEND_REQUEST_SENT_V1",
        payload: { requesterId: "requester", addresseeId: "recipient" },
      },
      audience: { recipientId: "recipient", facts: {} },
      projection: { id: "projection-1", deliveryKey: "visible:FRIEND_REQUEST_SENT:recipient:requester:recipient" },
    }),
    (error) => error?.message === "must not submit",
  );
});
