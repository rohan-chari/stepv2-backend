const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

test("featured race summaries aggregate participants instead of hydrating profiles", () => {
  const source = readFileSync(
    join(__dirname, "../../src/modules/races/models/race.js"),
    "utf8",
  );
  const start = source.indexOf("async findLiveSeededSummariesForUser");
  assert.notEqual(start, -1);
  const implementation = source.slice(start, source.indexOf("\n  },", start));
  assert.match(implementation, /COUNT\(\*\) FILTER/);
  assert.match(implementation, /viewer_status/);
  assert.doesNotMatch(implementation, /participantInclude|equippedAccessories/);
});
