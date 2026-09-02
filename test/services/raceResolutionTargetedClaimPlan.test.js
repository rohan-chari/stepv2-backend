const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

test("targeted race claims use the unique race key instead of the global queue plan", () => {
  const source = fs.readFileSync(path.join(
    __dirname,
    "../../src/modules/races/models/raceResolutionJobV2.js",
  ), "utf8");

  assert.match(source, /const candidatePredicate = raceId\s*\? "race_id = \$4"/);
  assert.match(source, /const candidateOrder = raceId\s*\? ""/);
  assert.doesNotMatch(source, /WHERE \(\$4::text IS NULL OR race_id = \$4\)/);
});
