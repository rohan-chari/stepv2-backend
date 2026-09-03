const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { describe, it } = require("node:test");

describe("race SQL list-summary shape", () => {
  it("builds rank rosters only for powerups and uses the live viewer placement for completed races", () => {
    const source = readFileSync(
      join(__dirname, "../../src/modules/races/models/race.js"),
      "utf8",
    );

    assert.match(source, /JSONB_OBJECT_AGG\([\s\S]*?AS viewer_positions/);
    assert.match(
      source,
      /JSONB_AGG\([\s\S]*?FILTER \(WHERE powerups_enabled = TRUE\)/,
    );
    assert.doesNotMatch(source, /OR race_status = 'completed'/);
    assert.match(
      source,
      /rankRoster: race\.powerupsEnabled === true && Array\.isArray\(row\.rankRoster\)/,
    );
    assert.match(
      source,
      /completedById\.has\(shared\.raceId\)[\s\S]*?viewer\?\.placement/,
    );
  });
});
