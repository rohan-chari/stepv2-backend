const assert = require("node:assert/strict");
const test = require("node:test");

const { preparationActions } = require("../../../performance/lib/environment");

test("prepared-environment invalidation performs only the required operation", () => {
  const binding = { code: "code-a", dataset: "data-a", hardware: "hardware-a" };
  assert.deepEqual(preparationActions(null, binding),
    ["ensureVm", "ensureDatabase", "ensureRedis", "ensureBackend"]);
  assert.deepEqual(preparationActions(binding, binding), []);
  assert.deepEqual(preparationActions(binding, { ...binding, code: "code-b" }), ["ensureBackend"]);
  assert.deepEqual(preparationActions(binding, { ...binding, dataset: "data-b" }),
    ["ensureDatabase", "ensureBackend"]);
  assert.deepEqual(preparationActions(binding, { ...binding, hardware: "hardware-b" }),
    ["ensureVm", "ensureDatabase", "ensureRedis", "ensureBackend"]);
});
