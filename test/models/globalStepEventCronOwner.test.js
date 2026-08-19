const assert = require("node:assert/strict");
const test = require("node:test");

const {
  heartbeatAndCheck,
} = require("../../src/modules/steps/models/globalStepEventCronOwner");

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
