const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { describe, it } = require("node:test");

describe("race SQL list-summary shape", () => {
  it("does not serialize the full ranked field for ordinary races", () => {
    const source = readFileSync(
      join(__dirname, "../../src/modules/races/models/race.js"),
      "utf8",
    );

    assert.match(source, /JSONB_OBJECT_AGG\([\s\S]*?AS viewer_positions/);
    assert.match(
      source,
      /JSONB_AGG\([\s\S]*?FILTER \(WHERE powerups_enabled = TRUE\)/,
    );
  });
});
