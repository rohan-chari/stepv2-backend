const assert = require("node:assert/strict");
const test = require("node:test");

const {
  heartbeatAndCheck,
} = require("../../src/modules/steps/models/globalStepEventCronOwner");

test("generation-two clients ignore legacy owner environment and use the exact census", async () => {
  let legacyHeartbeatWrites = 0;
  const readySince = new Date("2026-08-18T23:58:00.000Z");
  const owners = ["cron:0", "http:0", "http:1", "resolution:0"].map(
    (logicalOwnerId) => ({
      logicalOwnerId,
      generation: 2,
      capabilities: [
        "RECONCILER_OWNERSHIP",
        "SCHEDULED_EVENT_CONSUMER",
        "TARGET_AWARE_SENDER",
        "TOKEN_LIFECYCLE",
        "UNIVERSAL_C0_LOCK_ORDER",
      ],
    }),
  );
  const tx = {
    globalStepEventCronOwner: {
      async findMany() { return owners; },
      async upsert() { legacyHeartbeatWrites += 1; },
    },
    globalStepEventGenerationState: {
      async findUnique() { return { readySince }; },
      async upsert() { return { readySince }; },
      async update() { throw new Error("ready state should already exist"); },
    },
  };
  const client = {
    globalStepEventCronOwner: tx.globalStepEventCronOwner,
    globalStepEventGenerationState: tx.globalStepEventGenerationState,
    async $transaction(callback) { return callback(tx); },
  };

  assert.equal(await heartbeatAndCheck({
    client,
    ownerId: "prod-cron-0",
    expectedOwners: 1,
    now: new Date("2026-08-19T00:00:00.000Z"),
  }), true);
  assert.equal(legacyHeartbeatWrites, 0);
});

test("a live old-generation owner blocks local creation", async () => {
  const owners = [
    { generation: 1, localAware: false },
    { generation: 2, localAware: true },
  ];
  const model = {
    async upsert() {},
    async findMany() { return owners; },
  };
  const client = {
    async $transaction(callback) {
      return callback({ globalStepEventCronOwner: model });
    },
  };
  assert.equal(await heartbeatAndCheck({
    client,
    ownerId: "new-worker",
    expectedOwners: 2,
    now: new Date("2026-08-19T00:00:00Z"),
  }), false);
});

test("all configured live owners must be local-aware", async () => {
  const model = {
    async upsert() {},
    async findMany() {
      return [
        { generation: 2, localAware: true },
        { generation: 3, localAware: true },
      ];
    },
  };
  const client = { async $transaction(callback) {
    return callback({ globalStepEventCronOwner: model });
  } };
  assert.equal(await heartbeatAndCheck({ client, expectedOwners: 2 }), true);
});

test("missing explicit owner topology fails closed", async () => {
  assert.equal(await heartbeatAndCheck({ expectedOwners: null }), false);
});
