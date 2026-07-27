// Feature batch 2026-07-26 — pure helpers that an integration test cannot
// express at a sane cost (a structural guard over every placement site).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { describe, it } = require("node:test");

describe("batch 2026-07-26 — items 12/16: one shared placement comparator", () => {
  it("structural guard: every rank site imports the shared comparator", () => {
    const files = [
      "src/modules/races/queries/getRaces.js",
      "src/modules/home/getHomeRaceCard.js",
      "src/modules/races/queries/getRaceProgress.js",
      "src/modules/races/jobs/placementRecompute.js",
    ];
    for (const rel of files) {
      const source = fs.readFileSync(path.join(__dirname, "../..", rel), "utf8");
      assert.match(
        source,
        /require\(["'][^"']*placementOrder["']\)/,
        `${rel} must import the shared placementOrder module`
      );
      assert.doesNotMatch(
        source,
        /^function compareParticipantsForPlacement/m,
        `${rel} must not define its own comparator`
      );
    }
  });
});
