const assert = require("node:assert/strict");
const test = require("node:test");
const { KNOWN_FLAGS } = require("../../src/shared/config/appSettings");

test("dual box banners are a remotely killable flag defaulting off", () => {
  assert.equal(KNOWN_FLAGS.dualBoxBannersEnabled, false);
});
