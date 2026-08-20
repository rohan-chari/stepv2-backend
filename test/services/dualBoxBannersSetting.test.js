const assert = require("node:assert/strict");
const test = require("node:test");
const { KNOWN_FLAGS, PERMANENT_FLAGS } = require("../../src/shared/config/appSettings");

test("dual box banners are permanently enabled and no longer mutable", () => {
  assert.equal(KNOWN_FLAGS.dualBoxBannersEnabled, undefined);
  assert.equal(PERMANENT_FLAGS.dualBoxBannersEnabled, true);
});
