const assert = require("node:assert/strict");
const test = require("node:test");
const { raceResolutionArtifact } = require("../../src/shared/cache/cacheKeys");

test("display artifacts use only the opaque versioned resolution key", () => {
  assert.equal(
    raceResolutionArtifact("opaque-123"),
    "v1:race:resolution-artifact:opaque-123"
  );
  assert.throws(() => raceResolutionArtifact(""), /opaque artifact id/);
  assert.throws(() => raceResolutionArtifact("bad:id"), /opaque artifact id/);
});
